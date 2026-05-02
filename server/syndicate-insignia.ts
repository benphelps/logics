// Syndicate-insignia generation endpoint. Parallel to ship-art.ts but
// lighter: smaller cache key (syndicate id + accent + trait), one
// prompt template, same OpenAI / Gemini provider plumbing. Endpoints:
//
//   GET  /api/syndicate-insignia/options        — capability summary
//   GET  /api/syndicate-insignia/cache          — list of cache entries
//   GET  /api/syndicate-insignia/status/:id     — one entry
//   GET  /api/syndicate-insignia/image/:id      — image bytes
//   POST /api/syndicate-insignia/generate       — direct synchronous gen
//   POST /api/syndicate-insignia/for-syndicate  — cache-or-pending lookup
//
// Used by the Syndicates ledger tab as art splashes for each faction
// card; cache-keyed on (syndicateId, accentHex, traitId) so each
// syndicate keeps a stable image across visits.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

type Quality = "low" | "medium" | "high";
type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export type ImageProvider = "openai" | "gemini";

interface InsigniaRequest {
  syndicateId?: string;
  name?: string;
  accentHex?: string;
  traitId?: string;
  flavor?: string;
  size?: string;
  quality?: string;
  provider?: string;
}

interface NormalizedInsigniaInput {
  syndicateId: string;
  name: string;
  accentHex: string;
  traitId?: string;
  flavor?: string;
  size: ImageSize;
  quality: Quality;
  provider: ImageProvider;
}

interface InsigniaCacheEntry {
  id: string;
  poolKey: string;
  syndicateId: string;
  accentHex: string;
  traitId?: string;
  fileName?: string;
  mimeType?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: ImageProvider;
  size: string;
  quality: string;
  promptVersion: number;
  prompt: string;
  status: "pending" | "ready" | "failed";
  error?: string;
}

interface InsigniaCache {
  version: 1;
  entries: InsigniaCacheEntry[];
}

interface OpenAIImageResponse { data?: Array<{ b64_json?: string; url?: string }>; }
interface GeminiContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

const CACHE_VERSION = 1;
const CACHE_ROOT = resolve(process.cwd(), process.env.SYNDICATE_INSIGNIA_CACHE_DIR ?? ".logics-cache/syndicate-insignia");
const CACHE_INDEX_PATH = join(CACHE_ROOT, "index.json");
const IMAGE_DIR = join(CACHE_ROOT, "images");
const DEFAULT_OPENAI_MODEL = process.env.SYNDICATE_INSIGNIA_OPENAI_MODEL ?? process.env.SHIP_ART_OPENAI_MODEL ?? "gpt-image-1.5";
const DEFAULT_GEMINI_MODEL = process.env.SYNDICATE_INSIGNIA_GEMINI_MODEL ?? "gemini-2.5-flash-image";
const DEFAULT_OUTPUT_FORMAT = "webp";
const DEFAULT_QUALITY: Quality = "low";
const DEFAULT_SIZE: ImageSize = "1024x1024";
const DEFAULT_PROVIDER: ImageProvider = process.env.SYNDICATE_INSIGNIA_PROVIDER === "gemini" ? "gemini" : "openai";
const PROMPT_VERSION = 1;

const QUALITIES: Quality[] = ["low", "medium", "high"];
const SIZES: ImageSize[] = ["1024x1024", "1024x1536", "1536x1024"];
const PROVIDERS: ImageProvider[] = ["openai", "gemini"];

class InsigniaRequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- plugin + handler -------------------------------------------------

export function syndicateInsigniaDevServerPlugin(): Plugin {
  return {
    name: "logics-syndicate-insignia-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleSyndicateInsigniaRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          const status = error instanceof InsigniaRequestError ? error.status : 500;
          sendError(res, status, error instanceof Error ? error.message : "Unexpected insignia server error.");
        });
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleSyndicateInsigniaRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          const status = error instanceof InsigniaRequestError ? error.status : 500;
          sendError(res, status, error instanceof Error ? error.message : "Unexpected insignia server error.");
        });
      });
    },
  };
}

export async function handleSyndicateInsigniaRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/syndicate-insignia")) return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/syndicate-insignia/options") {
    sendJson(res, 200, { qualities: QUALITIES, sizes: SIZES, providers: PROVIDERS, defaultProvider: DEFAULT_PROVIDER, promptVersion: PROMPT_VERSION });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/syndicate-insignia/cache") {
    const cache = await readCache();
    sendJson(res, 200, { entries: cache.entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toClientEntry) });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/syndicate-insignia/status/")) {
    const id = url.pathname.slice("/api/syndicate-insignia/status/".length);
    const entry = (await readCache()).entries.find((e) => e.id === id);
    if (!entry) { sendError(res, 404, "Insignia not found."); return true; }
    sendJson(res, 200, { entry: toClientEntry(entry) });
    return true;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/syndicate-insignia/image/")) {
    await serveInsigniaImage(url.pathname, res, req.method === "HEAD");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/syndicate-insignia/generate") {
    const result = await generateInsignia(parseInsigniaInput(await readJsonBody<InsigniaRequest>(req)));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/syndicate-insignia/for-syndicate") {
    const result = await getOrCreateInsignia(parseInsigniaInput(await readJsonBody<InsigniaRequest>(req)));
    sendJson(res, 200, result);
    return true;
  }

  sendError(res, 404, "Unknown syndicate-insignia API route.");
  return true;
}

// --- core logic -------------------------------------------------------

function poolKey(input: NormalizedInsigniaInput): string {
  return `${input.syndicateId}|${input.accentHex.toLowerCase()}|${input.traitId ?? ""}|${input.size}|${input.quality}|${input.provider}|v${PROMPT_VERSION}`;
}

async function getOrCreateInsignia(input: NormalizedInsigniaInput) {
  const key = poolKey(input);
  const existing = await mutateCache((cache) => cache.entries.find((e) => e.poolKey === key && e.status !== "failed") ?? null);
  if (existing) {
    return { source: existing.status === "ready" ? "cache" as const : "pending" as const, entry: toClientEntry(existing) };
  }
  const id = randomUUID();
  const prompt = buildInsigniaPrompt(input);
  const model = modelFor(input.provider);
  const now = new Date().toISOString();
  const pending: InsigniaCacheEntry = {
    id, poolKey: key, syndicateId: input.syndicateId, accentHex: input.accentHex, traitId: input.traitId,
    createdAt: now, updatedAt: now, model, provider: input.provider, size: input.size, quality: input.quality,
    promptVersion: PROMPT_VERSION, prompt, status: "pending",
  };
  await mutateCache((cache) => { cache.entries.push(pending); });
  void generatePendingEntry(id, input).catch(() => undefined);
  return { source: "pending" as const, entry: toClientEntry(pending) };
}

async function generateInsignia(input: NormalizedInsigniaInput) {
  const key = poolKey(input);
  const existing = await mutateCache((cache) => cache.entries.find((e) => e.poolKey === key && e.status === "ready") ?? null);
  if (existing) return { source: "cache" as const, entry: toClientEntry(existing) };
  const id = randomUUID();
  await runGeneration(id, input);
  const finalEntry = (await readCache()).entries.find((e) => e.id === id);
  if (!finalEntry) throw new Error("Insignia entry vanished after generation.");
  return { source: "fresh" as const, entry: toClientEntry(finalEntry) };
}

async function generatePendingEntry(id: string, input: NormalizedInsigniaInput): Promise<void> {
  try {
    await runGeneration(id, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateCache((cache) => {
      const entry = cache.entries.find((e) => e.id === id);
      if (entry) { entry.status = "failed"; entry.error = message; entry.updatedAt = new Date().toISOString(); }
    });
  }
}

async function runGeneration(id: string, input: NormalizedInsigniaInput): Promise<void> {
  const prompt = buildInsigniaPrompt(input);
  const model = modelFor(input.provider);
  const now = new Date().toISOString();
  // Ensure pending entry exists (sync gen path mints it here).
  await mutateCache((cache) => {
    const existing = cache.entries.find((e) => e.id === id);
    if (existing) {
      existing.status = "pending";
      existing.updatedAt = now;
      existing.prompt = prompt;
      existing.model = model;
      return;
    }
    cache.entries.push({
      id, poolKey: poolKey(input), syndicateId: input.syndicateId, accentHex: input.accentHex, traitId: input.traitId,
      createdAt: now, updatedAt: now, model, provider: input.provider, size: input.size, quality: input.quality,
      promptVersion: PROMPT_VERSION, prompt, status: "pending",
    });
  });

  const { bytes, mimeType } = await generateImage(prompt, input);
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("jpeg") ? "jpg" : "webp";
  const fileName = `${id}.${ext}`;
  await mkdir(IMAGE_DIR, { recursive: true });
  await writeFile(join(IMAGE_DIR, fileName), bytes);
  await mutateCache((cache) => {
    const entry = cache.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.fileName = fileName;
    entry.mimeType = mimeType;
    entry.status = "ready";
    entry.updatedAt = new Date().toISOString();
    delete entry.error;
  });
}

// --- prompts ----------------------------------------------------------

function buildInsigniaPrompt(input: NormalizedInsigniaInput): string {
  const accent = input.accentHex.toLowerCase();
  const traitFlavor = TRAIT_VISUAL_BY_ID[input.traitId ?? ""] ?? "balanced abstract emblem with mechanical detailing";
  return [
    "Circular faction insignia for a sci-fi space-trading syndicate.",
    `Centred symmetric heraldic emblem in ${accent} accent on deep slate / black background, no white border, no frame, no text or letters anywhere in the image.`,
    "Crisp vector-illustration look: clean shapes, hard edges, two or three tone gradient inside the emblem, soft matte shadow under it.",
    `Visual motif: ${traitFlavor}.`,
    `Flavor: ${input.flavor ?? `Insignia for ${input.name}, an interstellar shipping syndicate.`}`,
    "Composition: emblem fills ~70% of the square frame, generous breathing room around it, no surrounding decorative borders.",
    "Suitable for use as a flat info-card splash. No people, no ships, no planets in the foreground — emblem only.",
  ].join(" ");
}

const TRAIT_VISUAL_BY_ID: Record<string, string> = {
  "free-traders":      "scales-and-coin motif inside a thin geared ring",
  "deep-haulers":      "stylised cargo crate flanked by twin parallel rails, weighty and squared",
  "swift-couriers":    "swept arrow-chevron mid-flight inside a hexagonal ring",
  "fuel-conservators": "single droplet wrapped in three orbiting concentric rings",
  "expediters":        "two crossed loading-arm pictograms over a clock-face dial",
  "engineers":         "geared cog with crossed wrench and spanner inside",
  "exchange-mavens":   "balanced trade glyph: a ledger column flanked by two rising arrows",
  "wardens":           "kite-shield silhouette with diagonal cross-bracing and a small pip at the apex",
};

// --- providers --------------------------------------------------------

async function generateImage(
  prompt: string,
  input: Pick<NormalizedInsigniaInput, "size" | "quality" | "provider">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (input.provider === "gemini") return generateImageGemini(prompt);
  return generateImageOpenAI(prompt, input);
}

async function generateImageOpenAI(prompt: string, input: Pick<NormalizedInsigniaInput, "size" | "quality">): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiKey = requireApiKey("OPENAI_API_KEY");
  const payload = { model: DEFAULT_OPENAI_MODEL, prompt, n: 1, size: input.size, quality: input.quality, output_format: DEFAULT_OUTPUT_FORMAT };
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI insignia generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  const json = await response.json() as OpenAIImageResponse;
  const image = json.data?.[0];
  if (image?.b64_json) return { bytes: Buffer.from(image.b64_json, "base64"), mimeType: "image/webp" };
  if (image?.url) {
    const r = await fetch(image.url);
    if (!r.ok) throw new Error(`Generated image download failed (${r.status}).`);
    return { bytes: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get("content-type") ?? "image/webp" };
  }
  throw new Error("OpenAI image response did not include image data.");
}

async function generateImageGemini(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiKey = requireApiKey("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini insignia generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  const json = await response.json() as GeminiContentResponse;
  if (json.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
  for (const candidate of json.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline && (inline as { data?: string }).data) {
        const data = (inline as { data: string }).data;
        const mt = (inline as { mimeType?: string; mime_type?: string }).mimeType ?? (inline as { mime_type?: string }).mime_type ?? "image/png";
        return { bytes: Buffer.from(data, "base64"), mimeType: mt };
      }
    }
  }
  throw new Error("Gemini response did not include image data.");
}

function modelFor(provider: ImageProvider): string {
  return provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENAI_MODEL;
}

function requireApiKey(envVar: string): string {
  const v = process.env[envVar];
  if (!v) throw new InsigniaRequestError(503, `${envVar} is not configured on this server.`);
  return v;
}

// --- input parsing ----------------------------------------------------

function parseInsigniaInput(raw: InsigniaRequest): NormalizedInsigniaInput {
  if (!raw.syndicateId || typeof raw.syndicateId !== "string") throw new InsigniaRequestError(400, "syndicateId is required.");
  if (!raw.accentHex || typeof raw.accentHex !== "string") throw new InsigniaRequestError(400, "accentHex is required.");
  const accent = /^#?([0-9a-f]{6})$/i.exec(raw.accentHex.trim());
  if (!accent) throw new InsigniaRequestError(400, "accentHex must be a 6-digit hex color.");
  const size = (SIZES as readonly string[]).includes(raw.size ?? "") ? (raw.size as ImageSize) : DEFAULT_SIZE;
  const quality = (QUALITIES as readonly string[]).includes(raw.quality ?? "") ? (raw.quality as Quality) : DEFAULT_QUALITY;
  const provider = (PROVIDERS as readonly string[]).includes(raw.provider ?? "") ? (raw.provider as ImageProvider) : DEFAULT_PROVIDER;
  return {
    syndicateId: raw.syndicateId,
    name: typeof raw.name === "string" ? raw.name : raw.syndicateId,
    accentHex: `#${accent[1].toLowerCase()}`,
    traitId: typeof raw.traitId === "string" ? raw.traitId : undefined,
    flavor: typeof raw.flavor === "string" ? raw.flavor : undefined,
    size, quality, provider,
  };
}

// --- cache I/O --------------------------------------------------------

let cachePromise: Promise<InsigniaCache> | null = null;
let cacheLock: Promise<unknown> = Promise.resolve();

async function readCache(): Promise<InsigniaCache> {
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        const text = await readFile(CACHE_INDEX_PATH, "utf8");
        const parsed = JSON.parse(text) as InsigniaCache;
        if (parsed?.version === CACHE_VERSION && Array.isArray(parsed.entries)) return parsed;
      } catch { /* missing or malformed — start fresh */ }
      return { version: CACHE_VERSION, entries: [] };
    })();
  }
  return cachePromise;
}

async function mutateCache<T>(mutator: (cache: InsigniaCache) => T): Promise<T> {
  const next = cacheLock.then(async () => {
    const cache = await readCache();
    const result = mutator(cache);
    await mkdir(CACHE_ROOT, { recursive: true });
    await writeFile(CACHE_INDEX_PATH, JSON.stringify(cache, null, 2));
    return result;
  });
  cacheLock = next.catch(() => undefined);
  return next;
}

function toClientEntry(entry: InsigniaCacheEntry) {
  return {
    id: entry.id,
    syndicateId: entry.syndicateId,
    accentHex: entry.accentHex,
    traitId: entry.traitId,
    status: entry.status,
    error: entry.error,
    imageUrl: entry.fileName && entry.status === "ready" ? `/api/syndicate-insignia/image/${entry.id}` : null,
    statusUrl: `/api/syndicate-insignia/status/${entry.id}`,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    provider: entry.provider,
    model: entry.model,
    promptVersion: entry.promptVersion,
  };
}

async function serveInsigniaImage(pathname: string, res: ServerResponse, headOnly: boolean): Promise<void> {
  const id = pathname.slice("/api/syndicate-insignia/image/".length);
  const entry = (await readCache()).entries.find((e) => e.id === id);
  if (!entry || entry.status !== "ready" || !entry.fileName) { sendError(res, 404, "Insignia image not found."); return; }
  const filePath = join(IMAGE_DIR, entry.fileName);
  res.statusCode = 200;
  res.setHeader("Content-Type", entry.mimeType ?? "image/webp");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (headOnly) { res.end(); return; }
  createReadStream(filePath).on("error", () => { if (!res.headersSent) sendError(res, 404, "Insignia image not found."); else res.destroy(); }).pipe(res);
}

// --- request helpers ---------------------------------------------------

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { throw new InsigniaRequestError(400, "Request body is not valid JSON."); }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  setCorsHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
