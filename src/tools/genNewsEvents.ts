// Bulk-generate news event templates via the OpenAI Chat Completions API
// using strict json_schema responses. Writes to public/news-events.json so
// the runtime UI can fetch it. Iterates batches; each batch is seeded with
// the last N templates plus a rolling "stateSeed" so the world stays
// thematically coherent across long runs.
//
//   npm run news:gen -- --count 200            # add 200 events to pool
//   npm run news:gen -- --count 50 --model gpt-5
//   npm run news:gen -- --count 5 --dry-run    # print plan without calling OpenAI

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NewsEventTemplate, NewsScope, NewsTargetKind } from "../sim/news/types";
import { GOODS } from "../sim/data/goods";

// --- CLI -------------------------------------------------------------------

interface CliOptions {
  count: number;
  batch: number;
  contextWindow: number;
  model: string;
  out: string;
  state: string;
  dryRun: boolean;
  help: boolean;
}

const DEFAULTS: CliOptions = {
  count: 50,
  batch: 5,
  contextWindow: 10,
  model: "gpt-5-mini",
  out: resolve(process.cwd(), "public/news-events.json"),
  state: resolve(process.cwd(), ".logics-cache/news-state.json"),
  dryRun: false,
  help: false,
};

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i] ?? "";
    if (/^\d+$/.test(tok)) { opts.count = parseInt(tok, 10); continue; }
    const [name, inline] = tok.split("=", 2);
    const value = (): string => inline ?? args[++i] ?? "";
    switch (name) {
      case "-h": case "--help":          opts.help = true; break;
      case "--dry-run":                  opts.dryRun = true; break;
      case "-n": case "--count":         opts.count = parseInt(value(), 10); break;
      case "--batch":                    opts.batch = parseInt(value(), 10); break;
      case "--context-window":           opts.contextWindow = parseInt(value(), 10); break;
      case "--model":                    opts.model = value(); break;
      case "--out":                      opts.out = resolve(process.cwd(), value()); break;
      case "--state":                    opts.state = resolve(process.cwd(), value()); break;
      default: throw new Error(`Unknown argument: ${tok}`);
    }
  }
  if (!Number.isFinite(opts.count) || opts.count < 1) throw new Error("count must be a positive integer");
  if (!Number.isFinite(opts.batch) || opts.batch < 1 || opts.batch > 50) throw new Error("batch must be 1..50");
  return opts;
}

// --- categories + scopes ---------------------------------------------------

const SEED_CATEGORIES: readonly string[] = [
  "weather", "politics", "war", "religion", "famine", "plague",
  "festival", "scandal", "discovery", "embargo", "sabotage",
  "pirate raid", "regulatory", "breakthrough", "miracle",
  "corruption", "crime", "lust", "greed", "acts of god",
  "revolt", "diplomacy", "bounty", "wedding", "celebrity",
];

const ALL_SCOPES: readonly NewsScope[] = [
  "commodity_price", "upgrade_cost",
  "maintenance", "crew_wage", "docking_fee",
  "contract_reward", "treasury_replenish", "treasury_yield",
  "share_price_station", "share_price_syndicate",
  "commodity_index_price", "basis_price", "futures_price",
  "dividend",
];

const ALL_TARGET_KINDS: readonly NewsTargetKind[] = ["good", "location", "syndicate", "index", "global"];
const GOOD_CATEGORIES = Array.from(new Set(Object.values(GOODS).map(g => g.category)));

// --- JSON schema for one batch --------------------------------------------

function buildBatchSchema(batchSize: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["events", "stateSeed"],
    properties: {
      stateSeed: { type: "string" },
      events: {
        type: "array",
        minItems: batchSize, maxItems: batchSize,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "category", "headline", "body", "effects",
            "durationBand", "magnitudeBand",
            "followthroughOf", "placeholderRequirements",
          ],
          properties: {
            id:       { type: "string", description: "kebab-case unique within the pool, e.g. plague-rim-002" },
            category: { type: "string", enum: [...SEED_CATEGORIES] },
            headline: { type: "string" },
            body:     { type: "string" },
            durationBand:  { type: "string", enum: ["short", "medium", "long"] },
            magnitudeBand: { type: "string", enum: ["low", "medium", "high"] },
            followthroughOf: { type: ["string", "null"] },
            placeholderRequirements: {
              type: "object",
              additionalProperties: false,
              required: ["station", "good", "syndicate", "person"],
              properties: {
                station:   { type: "boolean" },
                good:      { type: "boolean" },
                syndicate: { type: "boolean" },
                person:    { type: "boolean" },
              },
            },
            effects: {
              type: "array",
              minItems: 1, maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["scope", "target", "direction", "magnitude"],
                properties: {
                  scope:    { type: "string", enum: [...ALL_SCOPES] },
                  direction:{ type: "number", enum: [-1, 1] },
                  magnitude:{ type: "number", description: "Set to 0 to defer to magnitudeBand at spawn time" },
                  target: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "category"],
                    properties: {
                      kind:     { type: "string", enum: [...ALL_TARGET_KINDS] },
                      category: { type: ["string", "null"], description: "for 'good' kind, may be one of: " + GOOD_CATEGORIES.join(", ") },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

// --- prompt construction --------------------------------------------------

const SYSTEM_PROMPT = `You generate news-event templates for a space-trading sim.

Rules:
- Events are "things happening to the world" (storms, plagues, festivals, scandals, breakthroughs, raids, scandals, miracles) that *as a side effect* nudge math fields.
- Avoid direct market manipulation as the headline. Instead frame it as a real-world event whose effect on prices/costs/etc. is a consequence.
- Effects must be PLAUSIBLY connected to the event (e.g., a plague raises maintenance + commodity prices on luxury goods at a station, NOT "share prices of a random syndicate go up").
- Magnitude bands: low (5-10%), medium (10-18%), high (18-25%). Reserve "high" for genuinely headline events (war, plague, miracle).
- Duration bands: short (60-120 ticks), medium (120-300), long (300-600). Match the kind of event.
- Placeholders: use {station} {good} {syndicate} {person} where appropriate. If your headline references {station}, set placeholderRequirements.station = true (same for the others). NEVER put a literal name in the headline; always use placeholders.
- Effects target.id is intentionally absent — the runtime binds it at spawn time using the placeholders. So set target.kind = "good"/"location"/"syndicate"/"index"/"global" and optionally target.category for category-wide events.
- Set effect.magnitude = 0 unless you specifically want to lock a value. Defer to magnitudeBand for variability.
- Mix tones (good for player, bad for player, neutral). Mix categories.
- Use the prior events for thematic continuity but DO NOT duplicate them. Followthrough events (e.g., "after the plague, recovery aid arrives") set followthroughOf to the prior id; otherwise set followthroughOf to null.
- The stateSeed is your evolving narrative memory — write a 1-2 sentence summary of what's happening in the world, ongoing arcs, recurring threads, and pass it forward. Keep it under 400 chars.

Output JSON only, conforming to the schema. Each event id must be unique within the batch and unlikely to collide with prior ids.`;

function buildUserPrompt(opts: {
  batch: number;
  pool: NewsEventTemplate[];
  contextWindow: number;
  state: string;
  categoryHint: string;
}): string {
  const recent = opts.pool.slice(-opts.contextWindow).map(t => ({
    id: t.id, category: t.category, headline: t.headline,
    durationBand: t.durationBand, magnitudeBand: t.magnitudeBand,
  }));
  const lines: string[] = [];
  lines.push(`Generate ${opts.batch} new news-event templates.`);
  lines.push(`Current pool size: ${opts.pool.length}.`);
  lines.push(`Category to lean into for this batch (mix in others naturally): ${opts.categoryHint}.`);
  lines.push(`Recent prior templates (for context, do not duplicate):\n${JSON.stringify(recent, null, 2)}`);
  lines.push(`World state seed:\n${opts.state || "(empty — start fresh)"}`);
  lines.push(`Goods categories available for target.category: ${GOOD_CATEGORIES.join(", ")}.`);
  lines.push(`Available scopes: ${ALL_SCOPES.join(", ")}.`);
  lines.push(`Remember: produce JSON conforming to the schema; effect.magnitude=0 unless locking a specific value.`);
  return lines.join("\n\n");
}

// --- OpenAI call ----------------------------------------------------------

interface ApiBatchResponse {
  events: NewsEventTemplate[];
  stateSeed: string;
}

interface ChatChoice { message?: { content?: string } }
interface ChatCompletion { choices?: ChatChoice[]; error?: { message?: string } }

async function callOpenAI(opts: {
  apiKey: string;
  model: string;
  batchSize: number;
  systemPrompt: string;
  userPrompt: string;
}): Promise<ApiBatchResponse> {
  const body = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user",   content: opts.userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "news_batch",
        strict: true,
        schema: buildBatchSchema(opts.batchSize),
      },
    },
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 800)}`);
  }
  const json = await response.json() as ChatCompletion;
  if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI response had no content");
  return JSON.parse(text) as ApiBatchResponse;
}

// --- pool / state IO ------------------------------------------------------

interface PoolFile {
  events: NewsEventTemplate[];
  generatedAt: string;
  count: number;
}

interface StateFile {
  seed: string;
  updatedAt: string;
  totalGenerated: number;
}

async function loadPool(path: string): Promise<NewsEventTemplate[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return [];
  const data = JSON.parse(raw) as PoolFile | NewsEventTemplate[];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.events)) return data.events;
  return [];
}

async function savePool(path: string, events: NewsEventTemplate[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file: PoolFile = {
    events,
    generatedAt: new Date().toISOString(),
    count: events.length,
  };
  await writeFile(path, JSON.stringify(file, null, 2));
}

async function loadState(path: string): Promise<StateFile> {
  if (!existsSync(path)) {
    return { seed: "", updatedAt: new Date().toISOString(), totalGenerated: 0 };
  }
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as StateFile;
}

async function saveState(path: string, state: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

// --- main -----------------------------------------------------------------

function pickCategory(i: number): string {
  return SEED_CATEGORIES[i % SEED_CATEGORIES.length];
}

function dedupeIds(existing: Set<string>, batch: NewsEventTemplate[]): NewsEventTemplate[] {
  const out: NewsEventTemplate[] = [];
  for (const ev of batch) {
    let id = ev.id;
    let n = 2;
    while (existing.has(id)) {
      id = `${ev.id}-${n}`;
      n += 1;
    }
    existing.add(id);
    out.push({ ...ev, id });
  }
  return out;
}

function printHelp(): void {
  console.log(`Generate news-event templates via the OpenAI API.

Usage:
  npm run news:gen -- --count 200
  npm run news:gen -- --count 50 --batch 8 --model gpt-5
  npm run news:gen -- --count 5 --dry-run

Options:
  -n, --count <n>          Total templates to generate (default ${DEFAULTS.count}).
  --batch <n>              Templates per OpenAI request (default ${DEFAULTS.batch}, max 50).
  --context-window <n>     Prior templates passed for thematic continuity (default ${DEFAULTS.contextWindow}).
  --model <id>             Model id (default ${DEFAULTS.model}).
  --out <path>             Pool path (default public/news-events.json).
  --state <path>           Rolling state seed (default .logics-cache/news-state.json).
  --dry-run                Print the plan + first prompt; don't call OpenAI.
  -h, --help               Show this help.

Environment:
  OPENAI_API_KEY           Required unless --dry-run.`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  const pool = await loadPool(opts.out);
  const state = await loadState(opts.state);
  const existing = new Set(pool.map(p => p.id));

  const batches = Math.ceil(opts.count / opts.batch);
  console.log(`Plan: ${opts.count} templates in ${batches} batches of ${opts.batch}, model=${opts.model}`);
  console.log(`Existing pool: ${pool.length} → after run: ${pool.length + opts.count}`);
  console.log(`Pool out: ${opts.out}`);
  console.log(`State:    ${opts.state}`);

  if (opts.dryRun) {
    const sample = buildUserPrompt({
      batch: opts.batch, pool, contextWindow: opts.contextWindow,
      state: state.seed, categoryHint: pickCategory(0),
    });
    console.log("\n--- SAMPLE USER PROMPT (batch 1) ---\n");
    console.log(sample);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (or pass --dry-run).");

  let totalAdded = 0;
  let stateSeed = state.seed;
  for (let b = 0; b < batches; b++) {
    const remaining = opts.count - totalAdded;
    const size = Math.min(opts.batch, remaining);
    const categoryHint = pickCategory(state.totalGenerated + b);
    const userPrompt = buildUserPrompt({
      batch: size, pool, contextWindow: opts.contextWindow,
      state: stateSeed, categoryHint,
    });

    process.stdout.write(`batch ${b + 1}/${batches} (${categoryHint}, size=${size}) ... `);
    let result: ApiBatchResponse;
    try {
      result = await callOpenAI({
        apiKey, model: opts.model, batchSize: size,
        systemPrompt: SYSTEM_PROMPT, userPrompt,
      });
    } catch (err) {
      console.log("FAILED");
      throw err;
    }

    const deduped = dedupeIds(existing, result.events);
    pool.push(...deduped);
    totalAdded += deduped.length;
    stateSeed = result.stateSeed || stateSeed;

    // Save after each batch so a partial run is preserved.
    await savePool(opts.out, pool);
    await saveState(opts.state, {
      seed: stateSeed,
      updatedAt: new Date().toISOString(),
      totalGenerated: state.totalGenerated + totalAdded,
    });
    console.log(`+${deduped.length} → ${pool.length} total`);
  }

  console.log(`\nDone. Added ${totalAdded} templates. Pool now ${pool.length}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
