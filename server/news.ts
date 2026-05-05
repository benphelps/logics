// News-generation endpoints. Two POSTs:
//
//   POST /api/news/backstory  — generate the per-game UniverseBackstory.
//                                Cached by gameId on disk so reloads don't
//                                re-bill the LLM.
//   POST /api/news/event      — generate one news event for a target. Not
//                                cached; each call returns a fresh event.
//
// Backed by Anthropic Claude Haiku — structured JSON output via prompt
// instruction + JSON.parse on the response. Extracts the first balanced
// JSON object from the model output to be robust against incidental
// pre/post-amble text.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

const CACHE_ROOT = resolve(process.cwd(), process.env.LEDGWAY_NEWS_CACHE_DIR ?? ".ledgway-cache/news");
const BACKSTORY_DIR = join(CACHE_ROOT, "backstories");

const DEFAULT_MODEL = process.env.NEWS_MODEL ?? "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = Number(process.env.NEWS_MAX_TOKENS ?? 1500);

class NewsRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- request shapes -------------------------------------------------------

interface BackstoryRequestBody {
  gameId?: string;
  syndicates?: { id: string; name: string; trait?: string; accentHex?: string }[];
  locations?: { id: string; name: string; faction?: string; population?: number; tags?: string[] }[];
  // Optional tonal hint from the player ("gritty smuggler era", etc).
  tone?: string;
}

interface NewsEventRequestBody {
  gameId?: string;
  backstory?: import("../src/sim/types.js").UniverseBackstory;
  target?: NewsEventTargetSpec;
  recentEvents?: { headline: string; tone?: string; tick: number }[];
  worldSignals?: Record<string, unknown>;
  // Player ask: "ramp up tensions" / "calm sector". Maps to mean-reversion
  // bias hint that nudges the model toward a direction.
  biasHint?: "favor_negative" | "favor_positive" | "neutral";
  tickNow?: number;
}

interface NewsEventTargetSpec {
  // Maps to NewsTargetKind: "global" | "location" | "syndicate" | "good".
  kind: "global" | "location" | "syndicate" | "good";
  id?: string;
  // Optional category — for "all locations in syndicate X" use
  // category: "<syndicateId>" with kind: "location".
  category?: string;
  // Friendly label the prompt builder can drop into the model context
  // (e.g. "Veridian Stays", "Khoros Combine", "the entire sector").
  label?: string;
}

// --- shared helpers ------------------------------------------------------

async function ensureCacheDirs(): Promise<void> {
  await mkdir(BACKSTORY_DIR, { recursive: true });
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new NewsRequestError(500, "ANTHROPIC_API_KEY is required to generate news events.");
  }
  return key.trim();
}

interface ClaudeContentBlock { type: string; text?: string }
interface ClaudeMessageResponse { content?: ClaudeContentBlock[]; stop_reason?: string }

async function callClaude(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = getApiKey();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? MAX_TOKENS,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NewsRequestError(res.status, `Claude request failed: ${res.status} ${text.slice(0, 240)}`);
  }
  const data = await res.json() as ClaudeMessageResponse;
  const text = (data.content ?? []).map(c => c.text ?? "").join("").trim();
  if (!text) throw new NewsRequestError(502, "Claude returned no text content.");
  return text;
}

// Pull the first balanced JSON object out of a possibly-noisy model response.
// Scans for the opening brace, then tracks brace depth. Returns the matched
// substring or null when the response isn't recoverable as JSON.
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseModelJson<T>(raw: string): T {
  const block = extractFirstJsonObject(raw);
  if (!block) {
    throw new NewsRequestError(502, `Claude response did not contain a JSON object: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(block) as T;
  } catch (e) {
    throw new NewsRequestError(502, `Claude JSON parse failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

// --- backstory ------------------------------------------------------------

interface CachedBackstory {
  gameId: string;
  generatedAt: string;
  model: string;
  backstory: import("../src/sim/types.js").UniverseBackstory;
}

const BACKSTORY_SYSTEM = `You are the lore writer for a space trading game called Ledgway.
You write the universe's setting bible: present-day political, economic, and social context that breaking-news headlines will refer back to. Tone is grounded sci-fi — colonial trade routes, charter syndicates, frontier stations, no Star Wars-isms, no "Galactic Empire" cliches. Write tight, evocative prose with concrete proper nouns.
ALWAYS respond with a single JSON object that matches the schema the user describes — no markdown, no commentary, just the JSON.`;

function buildBackstoryUserPrompt(body: BackstoryRequestBody): string {
  const synds = (body.syndicates ?? []).map(s => `- ${s.name}${s.trait ? ` (${s.trait})` : ""}`).join("\n");
  const stations = (body.locations ?? []).slice(0, 12).map(l => `- ${l.name}${l.faction ? ` [${l.faction}]` : ""}${l.tags && l.tags.length ? ` tags=${l.tags.join("/")}` : ""}`).join("\n");
  const tone = body.tone ? `\nPLAYER TONE HINT: ${body.tone}` : "";
  return `Write the present-day backstory for a Ledgway universe.

SYNDICATES (the player will pick one as their home):
${synds || "(unspecified)"}

KEY STATIONS:
${stations || "(unspecified)"}
${tone}

Output JSON with this shape:
{
  "tagline": "12-word setting hook, no quotes inside",
  "era": "current period's thematic name, 1-3 words (e.g. 'Late Charter Era', 'Boundary Frictions') — NEVER use years or dates",
  "political": "1 paragraph (60-90 words) on the political situation among the syndicates",
  "economic": "1 paragraph (60-90 words) on trade, shortages, production hubs",
  "tensions": "1 paragraph (60-90 words) on unresolved tensions and brewing conflicts",
  "storyBeats": [
    { "label": "thematic chapter name", "summary": "1-2 sentences" },
    ...
  ]
}

CRITICAL: Ledgway has no in-game calendar — there are no years, dates, or numeric timestamps in this universe. NEVER write "2245-2280", "in 2189", "the third decade", etc. Story chapters are NAMED phases like "The Splintering", "Charter Compact", "Vault Rights Dispute".

Include 3-5 storyBeats — thematic anchors covering the run-up to the current era. Reference actual syndicate and station names above. Concrete proper nouns drive immersion. Avoid generic placeholders.`;
}

async function generateBackstory(body: BackstoryRequestBody): Promise<{ backstory: import("../src/sim/types.js").UniverseBackstory; cached: boolean }> {
  await ensureCacheDirs();
  const gameId = optionalText(body.gameId, 64);
  if (!gameId) throw new NewsRequestError(400, "gameId is required.");

  // Cache hit short-circuit. Backstories are minted once per game so we
  // don't re-bill on dev reloads or save-revisits.
  const cachePath = join(BACKSTORY_DIR, `${sanitizeFileName(gameId)}.json`);
  try {
    const data = await readFile(cachePath, "utf8");
    const cached = JSON.parse(data) as CachedBackstory;
    if (cached.backstory && cached.gameId === gameId) {
      return { backstory: cached.backstory, cached: true };
    }
  } catch {
    // Miss — generate.
  }

  const raw = await callClaude({
    system: BACKSTORY_SYSTEM,
    user: buildBackstoryUserPrompt(body),
    maxTokens: 2000,
  });
  const parsed = parseModelJson<Partial<import("../src/sim/types.js").UniverseBackstory>>(raw);
  const backstory = sanitizeBackstory(parsed);

  const entry: CachedBackstory = {
    gameId,
    generatedAt: new Date().toISOString(),
    model: DEFAULT_MODEL,
    backstory,
  };
  await writeFile(cachePath, JSON.stringify(entry, null, 2), "utf8");
  return { backstory, cached: false };
}

function sanitizeBackstory(p: Partial<import("../src/sim/types.js").UniverseBackstory>): import("../src/sim/types.js").UniverseBackstory {
  // Accept either the new "storyBeats" key or the legacy "timelineBeats"
  // key during the transition — model output sometimes echoes whatever
  // labels show up in the prompt history.
  const rawBeats: unknown[] = Array.isArray((p as Record<string, unknown>).storyBeats)
    ? (p as Record<string, unknown>).storyBeats as unknown[]
    : Array.isArray((p as Record<string, unknown>).timelineBeats)
      ? (p as Record<string, unknown>).timelineBeats as unknown[]
      : [];
  const beats = rawBeats
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .map(b => ({
      // Accept "label" (new shape) or "era" (legacy) so model stragglers
      // still parse cleanly.
      label: String(b.label ?? b.era ?? "").slice(0, 80),
      summary: String(b.summary ?? "").slice(0, 400),
    }))
    .filter(b => b.label.length > 0 && b.summary.length > 0)
    .slice(0, 6);
  return {
    tagline: String(p.tagline ?? "").slice(0, 200),
    era: String(p.era ?? "").slice(0, 60),
    political: String(p.political ?? "").slice(0, 1200),
    economic: String(p.economic ?? "").slice(0, 1200),
    tensions: String(p.tensions ?? "").slice(0, 1200),
    storyBeats: beats,
    generatedAt: 0,
  };
}

// --- event ----------------------------------------------------------------

const EVENT_SYSTEM = `You are the breaking-news desk for a space trading game called Ledgway.
You write one news event at a time, in-universe, that affects gameplay through a small set of "scopes" the simulation reads. Tone is wire-service neutral — no exclamation points, no editorialising, no Star Wars-isms.
Output a single JSON object only — no markdown, no preamble.

The "effects" you produce nudge sim values up or down for a bounded duration. Each effect has:
  scope: which sim system it touches
  target: { kind: "global" | "location" | "syndicate" | "good", id?, category? }
  direction: 1 = increase, -1 = decrease
  magnitude: 0.05 .. 0.30 (clamped server-side)

Pick scopes that fit the headline. Common scopes:
  encounter_chance         — pirate raids, patrol sweeps, shipping lane safety
  commodity_price          — shortages, harvests, trade embargoes
  share_price_station      — local boom or bust
  share_price_syndicate    — faction stock movements
  maintenance / docking_fee / contract_reward / treasury_replenish — economy levers

Keep each event to 1-3 effects. Use direction:1 for "tensions up / risk up / cost up" and -1 for the inverse.`;

function buildEventUserPrompt(body: NewsEventRequestBody): string {
  const back = body.backstory;
  const target = body.target ?? { kind: "global" };
  const recent = (body.recentEvents ?? []).slice(-3).map((e, i) => `  ${i + 1}. (t${e.tick}) ${e.headline}${e.tone ? ` [${e.tone}]` : ""}`).join("\n");
  const signals = body.worldSignals ? `\nCURRENT STATE SIGNALS:\n${JSON.stringify(body.worldSignals, null, 2)}` : "";
  const biasLine = body.biasHint && body.biasHint !== "neutral"
    ? `\nBIAS HINT: lean ${body.biasHint === "favor_negative" ? "toward escalation / cost up / risk up" : "toward de-escalation / cost down / safety up"}.`
    : "";
  const targetLine = target.label
    ? `${target.kind} (${target.label}${target.id ? ` · ${target.id}` : ""})`
    : `${target.kind}${target.id ? ` (${target.id})` : ""}`;

  const lore = back ? `UNIVERSE BACKSTORY (drawn from):
- Tagline: ${back.tagline}
- Era: ${back.era}
- Political: ${back.political}
- Economic: ${back.economic}
- Tensions: ${back.tensions}
- Timeline beats:
${back.storyBeats.map((b: { label: string; summary: string }) => `  · ${b.label}: ${b.summary}`).join("\n")}` : "(no backstory provided)";

  return `Generate ONE news event in this universe.

${lore}

EVENT TARGET TIER: ${targetLine}

RECENT EVENTS AT THIS TARGET:
${recent || "(none — fresh territory)"}
${signals}${biasLine}

If RECENT EVENTS exist, write a follow-up that continues or escalates that thread. Otherwise pick a fresh angle that fits the universe's current tensions and the target's tier.

Output JSON:
{
  "headline": "wire-style headline, max 70 chars",
  "body": "1-3 sentences elaborating, max 320 chars",
  "tone": "good" | "bad" | "warn" | "info",
  "category": "weather|politics|war|plague|festival|scandal|trade|piracy|patrol|labor|tech",
  "durationBand": "short" | "medium" | "long",
  "magnitudeBand": "low" | "medium" | "high",
  "effects": [
    {
      "scope": "encounter_chance",
      "target": { "kind": "${target.kind}"${target.id ? `, "id": "${target.id}"` : ""}${target.category ? `, "category": "${target.category}"` : ""} },
      "direction": 1,
      "magnitude": 0.18
    }
  ]
}`;
}

interface NewsEventResponse {
  headline: string;
  body: string;
  tone: string;
  category: string;
  durationBand: "short" | "medium" | "long";
  magnitudeBand: "low" | "medium" | "high";
  effects: Array<{
    scope: string;
    target: NewsEventTargetSpec;
    direction: 1 | -1;
    magnitude: number;
  }>;
}

async function generateEvent(body: NewsEventRequestBody): Promise<NewsEventResponse> {
  const raw = await callClaude({
    system: EVENT_SYSTEM,
    user: buildEventUserPrompt(body),
    maxTokens: 800,
  });
  const parsed = parseModelJson<Partial<NewsEventResponse>>(raw);
  return sanitizeEvent(parsed, body.target ?? { kind: "global" });
}

const VALID_TONES = new Set(["good", "bad", "warn", "info"]);
const VALID_DUR = new Set(["short", "medium", "long"]);
const VALID_MAG = new Set(["low", "medium", "high"]);

function sanitizeEvent(p: Partial<NewsEventResponse>, fallbackTarget: NewsEventTargetSpec): NewsEventResponse {
  const tone = typeof p.tone === "string" && VALID_TONES.has(p.tone) ? p.tone : "info";
  const durationBand = typeof p.durationBand === "string" && VALID_DUR.has(p.durationBand) ? p.durationBand as "short" | "medium" | "long" : "medium";
  const magnitudeBand = typeof p.magnitudeBand === "string" && VALID_MAG.has(p.magnitudeBand) ? p.magnitudeBand as "low" | "medium" | "high" : "medium";
  const effects: NewsEventResponse["effects"] = Array.isArray(p.effects)
    ? p.effects
        .filter((e): e is NonNullable<typeof e> => !!e && typeof e === "object")
        .slice(0, 3)
        .map((e): NewsEventResponse["effects"][number] => ({
          scope: String(e.scope ?? "").slice(0, 60),
          target: sanitizeTarget(e.target, fallbackTarget),
          direction: e.direction === -1 ? -1 : 1,
          magnitude: clamp(Number(e.magnitude ?? 0.15), 0.05, 0.30),
        }))
        .filter(e => e.scope.length > 0)
    : [];
  return {
    headline: String(p.headline ?? "").slice(0, 200),
    body: String(p.body ?? "").slice(0, 500),
    tone,
    category: String(p.category ?? "").slice(0, 40) || "trade",
    durationBand,
    magnitudeBand,
    effects: effects.length > 0 ? effects : [{
      scope: "encounter_chance",
      target: fallbackTarget,
      direction: 1,
      magnitude: 0.10,
    }],
  };
}

function sanitizeTarget(t: unknown, fallback: NewsEventTargetSpec): NewsEventTargetSpec {
  if (!t || typeof t !== "object") return { ...fallback };
  const obj = t as Record<string, unknown>;
  const kind = typeof obj.kind === "string" && ["global", "location", "syndicate", "good"].includes(obj.kind)
    ? obj.kind as NewsEventTargetSpec["kind"]
    : fallback.kind;
  const out: NewsEventTargetSpec = { kind };
  if (typeof obj.id === "string" && obj.id.length > 0) out.id = obj.id.slice(0, 80);
  if (typeof obj.category === "string" && obj.category.length > 0) out.category = obj.category.slice(0, 80);
  if (!out.id && !out.category && fallback.id) out.id = fallback.id;
  if (!out.id && !out.category && fallback.category) out.category = fallback.category;
  return out;
}

// --- HTTP plumbing -------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function optionalText(value: string | undefined, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; }
  catch { throw new NewsRequestError(400, "Body is not valid JSON."); }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

export async function handleNewsRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/news")) return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/news/backstory") {
    const body = await readJsonBody<BackstoryRequestBody>(req);
    const result = await generateBackstory(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/news/event") {
    const body = await readJsonBody<NewsEventRequestBody>(req);
    const event = await generateEvent(body);
    sendJson(res, 200, { event });
    return true;
  }

  sendError(res, 404, "Unknown news endpoint.");
  return true;
}

export function newsDevServerPlugin(): Plugin {
  return {
    name: "ledgway-news-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleNewsRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          const status = error instanceof NewsRequestError ? error.status : 500;
          sendError(res, status, error instanceof Error ? error.message : "Unexpected news server error.");
        });
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleNewsRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          const status = error instanceof NewsRequestError ? error.status : 500;
          sendError(res, status, error instanceof Error ? error.message : "Unexpected news server error.");
        });
      });
    },
  };
}
