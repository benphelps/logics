import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import type { Plugin } from "vite";

type HeadshotQuality = "low" | "medium" | "high";
type HeadshotSize = "1024x1024" | "1024x1536" | "1536x1024";
export type HeadshotSex = "female" | "male" | "nonbinary";
export type HeadshotAge = "young adult" | "adult" | "middle aged" | "elderly";
export type HeadshotRace = "human" | "alien";

interface HeadshotRequest {
  role?: string;
  race?: string;
  sex?: string;
  age?: string;
  clothing?: string;
  subjectId?: string;
}

interface ReleaseRequest {
  subjectId?: string;
}

export interface HeadshotSeedInput {
  role: string;
  race: HeadshotRace;
  sex: HeadshotSex;
  age: HeadshotAge;
}

interface NormalizedHeadshotInput {
  role: string;
  race: HeadshotRace;
  sex: HeadshotSex;
  age: HeadshotAge;
  clothing?: string;
  subjectId?: string;
  quality: HeadshotQuality;
  size: HeadshotSize;
}

// `subjectId` scopes a claim to a specific in-game entity (a CrewMember
// or a Hire offer), so two offers with the same role/race/sex/age in the
// same save get distinct portraits. Legacy entries written before this
// field was introduced have it absent — we treat that as a wildcard
// "this game" claim and only allow one such per game (the original
// behavior).
interface HeadshotUse {
  gameId: number;
  subjectId?: string;
  claimedAt: string;
}

interface HeadshotCacheEntry {
  id: string;
  poolKey: string;
  role: string;
  race: HeadshotRace;
  sex: HeadshotSex;
  age: HeadshotAge;
  clothing?: string;
  fileName?: string;
  mimeType?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  size: string;
  quality: string;
  promptVersion?: number;
  prompt: string;
  status: "pending" | "ready" | "failed";
  unique: boolean;
  error?: string;
  uses: HeadshotUse[];
}

interface HeadshotCache {
  version: 6;
  entries: HeadshotCacheEntry[];
}

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

const CACHE_VERSION = 6;
const CACHE_ROOT = resolve(process.cwd(), process.env.HEADSHOT_CACHE_DIR ?? ".ledgway-cache/headshots");
const CACHE_INDEX_PATH = join(CACHE_ROOT, "index.json");
const IMAGE_DIR = join(CACHE_ROOT, "images");
const DEFAULT_MODEL = process.env.HEADSHOT_IMAGE_MODEL ?? "gpt-image-1.5";
const DEFAULT_OUTPUT_FORMAT = process.env.HEADSHOT_IMAGE_FORMAT ?? "webp";
const DEFAULT_QUALITY: HeadshotQuality = "low";
const DEFAULT_SIZE: HeadshotSize = "1024x1024";
const PROMPT_VERSION = 4;
const POOL_LOW_WATERMARK = 1;
const POOL_REFILL_COUNT = 2;
const activeRefills = new Set<string>();
let cacheMutationQueue = Promise.resolve();

class HeadshotRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ROLES = [
  "pilot",
  "navigator",
  "mechanic",
  "ship captain",
  "station broker",
  "trade analyst",
  "freighter crew",
  "security officer",
  "mercenary",
];

const QUALITIES: HeadshotQuality[] = ["low", "medium", "high"];
const SIZES: HeadshotSize[] = ["1024x1024", "1024x1536", "1536x1024"];
const RACES: HeadshotRace[] = ["human", "alien"];
const SEXES: HeadshotSex[] = ["female", "male", "nonbinary"];
const AGES: HeadshotAge[] = ["young adult", "adult", "middle aged", "elderly"];

const ROLE_PROMPTS: Record<string, {
  background: string;
  clothing: string;
  props: string;
  lighting: string;
  posture: string;
}> = {
  "pilot": {
    background: "compact cockpit canopy, throttle yoke, worn restraint harness, tiny unreadable warning lights, stars and docking gantry outside the glass",
    clothing: "fitted flight suit, pressure collar, clipped-up comm headset, worn shoulder patches with no readable writing",
    props: "one gloved hand near a flight control, subtle reflection from instrument glass across the cheek",
    lighting: "cool canopy rim light with small amber instrument highlights",
    posture: "forward-leaning, alert, ready to launch",
  },
  "navigator": {
    background: "quiet astrometry alcove, layered holographic star charts, route plotting console, deep-space map glow with no readable text",
    clothing: "tailored navigation coat, soft collar, slim sensor earpiece, chart-room utility straps",
    props: "thin light from a projected route crossing the face, fingers near a translucent plotting surface",
    lighting: "cyan star-map light and violet shadow, calmer than the cockpit",
    posture: "focused and analytical, eyes tracking an off-camera route",
  },
  "mechanic": {
    background: "engine bay maintenance crawlspace, exposed conduits, heat shielding, suspended repair lights, practical grime and vapor",
    clothing: "reinforced work coveralls, tool harness, rolled sleeves or padded gloves, scuffed protective collar",
    props: "small diagnostic tool, grease marks, welding-glow edge light away from the face",
    lighting: "warm sodium work light mixed with cold blue reactor spill",
    posture: "grounded and hands-on, shoulders squared after repair work",
  },
  "ship captain": {
    background: "command bridge, captain chair silhouette, viewport with station traffic, tactical panels blurred with no readable text",
    clothing: "structured command jacket, high collar, understated rank hardware without words",
    props: "command rail or armrest in the foreground, distant crew stations out of focus",
    lighting: "broad bridge key light with crisp rim light from the viewport",
    posture: "calm authority, composed and decisive",
  },
  "station broker": {
    background: "station exchange booth, layered commodity tickers rendered abstractly, glass partitions, busy trade concourse beyond",
    clothing: "sharp broker jacket, metallic lapel clasp, discreet comm bead, polished but practical",
    props: "ledger slate or contract chip held low, reflective glass separating the trade floor",
    lighting: "cool finance-floor light with restrained gold accents",
    posture: "measured, calculating, socially fluent",
  },
  "trade analyst": {
    background: "dim analytics pit, stacked translucent charts, risk boards and market graphs blurred into abstract shapes",
    clothing: "minimal technical vest over station office wear, data gloves or wrist terminal",
    props: "soft chart glow across the eyes, stylus or wrist terminal visible at the frame edge",
    lighting: "blue-white monitor glow with deep charcoal surroundings",
    posture: "precise and observant, mid-thought rather than dramatic",
  },
  "freighter crew": {
    background: "cargo hold catwalk, strapped containers, mag-lock rails, loader bay haze, industrial depth behind the shoulders",
    clothing: "rugged cargo vest, padded work shirt, harness clips, worn fabric and scratched buckles",
    props: "cargo scanner or strap hook, container edge framing one side of the portrait",
    lighting: "muted bay lights with dusty shafts and soft blue dock glow",
    posture: "practical and steady, used to heavy ship work",
  },
  "security officer": {
    background: "station checkpoint or ship airlock security post, armored door, scanner arch, warning lights abstracted with no readable text",
    clothing: "matte security armor panels over a dark uniform, shoulder radio, compact protective collar",
    props: "holstered sidearm or scanner kept low and non-threatening, checkpoint rail behind",
    lighting: "harder overhead security light with red-blue accents kept subtle",
    posture: "watchful, disciplined, protective",
  },
  "mercenary": {
    background: "ship gunbay alcove, exposed weapon mounts and ammunition crates, scratched plating, scorched paint, no readable markings",
    clothing: "battle-worn combat fatigues, plate carrier with scuffed pauldrons, gauntleted forearm cuffs, fingerless gloves, a small enamel unit pin without text",
    props: "one hand resting on a weapon strap or holstered sidearm at the hip, knuckle dust or carbon scoring on the sleeve",
    lighting: "low-angle warning amber from the weapon bay mixed with cool corridor blue, harder shadows than the rest of the crew",
    posture: "loose-shouldered and ready, weight slightly forward, neither dramatic nor showy — career professional, not an action hero",
  },
};

export function headshotDevServerPlugin(): Plugin {
  return {
    name: "ledgway-headshot-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleHeadshotRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          sendError(res, error instanceof HeadshotRequestError ? error.status : 500, error instanceof Error ? error.message : "Unexpected headshot server error.");
        });
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleHeadshotRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          sendError(res, error instanceof HeadshotRequestError ? error.status : 500, error instanceof Error ? error.message : "Unexpected headshot server error.");
        });
      });
    },
  };
}

export function getHeadshotSeedOptions() {
  return {
    roles: ROLES,
    races: RACES,
    sexes: SEXES,
    ages: AGES,
    qualities: QUALITIES,
    sizes: SIZES,
    promptVersion: PROMPT_VERSION,
  };
}

export async function seedCachedHeadshot(rawInput: HeadshotSeedInput) {
  const input = parseHeadshotInput(rawInput);
  const entry = await createCachedEntry(getApiKey(), input);
  const available = await mutateCache((cache) => {
    cache.entries.push(entry);
    return countUnusedEntries(cache, input);
  });
  return {
    entry: toClientEntry(entry),
    prompt: entry.prompt,
    available,
  };
}

export async function handleHeadshotRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/headshots")) return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/headshots/options") {
    sendJson(res, 200, getHeadshotSeedOptions());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/headshots/cache") {
    const cache = await readCache();
    const entries = cache.entries
      .filter((entry) => matchesQuery(entry, url.searchParams))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toClientEntry);
    sendJson(res, 200, { entries });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/headshots/status/")) {
    await serveHeadshotStatus(url.pathname, res);
    return true;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/headshots/image/")) {
    await serveHeadshotImage(url.pathname, res, req.method === "HEAD");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/headshots/generate") {
    const result = await generatePreviewHeadshot(parseHeadshotInput(await readJsonBody<HeadshotRequest>(req)));
    sendJson(res, 200, result);
    return true;
  }

  const gameRoute = parseGameRoute(url.pathname);
  if (req.method === "POST" && gameRoute?.action === "allocate") {
    const result = await allocateHeadshot(gameRoute.gameId, parseHeadshotInput(await readJsonBody<HeadshotRequest>(req)));
    sendJson(res, result.source === "pending" ? 202 : 200, result);
    return true;
  }

  if (req.method === "POST" && gameRoute?.action === "release") {
    const result = await releaseHeadshot(gameRoute.gameId, await readJsonBody<ReleaseRequest>(req));
    sendJson(res, 200, result);
    return true;
  }

  sendError(res, 404, "Unknown headshot API route.");
  return true;
}

async function generatePreviewHeadshot(input: NormalizedHeadshotInput) {
  const prompt = buildPrompt(input);
  const image = await generateImage(getApiKey(), prompt, input);
  return {
    source: "preview",
    entry: toClientGeneratedEntry({
      id: `preview-${randomUUID()}`,
      input,
      mimeType: image.mimeType,
      imageUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
    }),
    prompt,
  };
}

async function allocateHeadshot(gameId: number, input: NormalizedHeadshotInput) {
  if (input.clothing) {
    const entry = await createPendingUniqueEntry(gameId, input);
    void generatePendingEntry(entry.id, input);
    return {
      source: "pending" as const,
      entry: toClientEntry(entry),
      prompt: entry.prompt,
      claimed: true,
      refill: { queued: false, available: 0 },
    };
  }

  // Cache lookup + (if needed) inserting a pending placeholder are the
  // only mutations done under the cache lock — no OpenAI calls. This
  // keeps the vite middleware queue responsive: every allocate returns
  // within a single fs read+write, and the slow image generation runs
  // afterwards in the background.
  const result = await mutateCache((cache) => {
    const existing = findReusableEntry(cache, input, gameId, input.subjectId);
    if (existing) {
      const claimed = claimForGame(existing, gameId, input.subjectId);
      const source = existing.status === "ready" ? "cache" as const : "pending" as const;
      return {
        entry: existing,
        source,
        prompt: existing.prompt,
        claimed,
        available: countUnusedEntries(cache, input),
        startGeneration: false,
      };
    }

    const entry = createPendingPoolEntry(input, gameId, input.subjectId);
    cache.entries.push(entry);
    return {
      entry,
      source: "pending" as const,
      prompt: entry.prompt,
      claimed: true,
      available: countUnusedEntries(cache, input),
      startGeneration: true,
    };
  });

  if (result.startGeneration) {
    void generatePendingEntry(result.entry.id, input);
  }
  const refill = schedulePoolRefill(input, result.available);
  return {
    source: result.source,
    entry: toClientEntry(result.entry),
    prompt: result.prompt,
    claimed: result.claimed,
    refill,
  };
}

function createPendingPoolEntry(input: NormalizedHeadshotInput, gameId: number, subjectId?: string): HeadshotCacheEntry {
  const prompt = buildPrompt(input);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    poolKey: poolKey(input),
    role: input.role,
    race: input.race,
    sex: input.sex,
    age: input.age,
    clothing: input.clothing,
    createdAt: now,
    updatedAt: now,
    model: DEFAULT_MODEL,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "pending",
    unique: false,
    uses: [{ gameId, subjectId, claimedAt: now }],
  };
}

async function releaseHeadshot(gameId: number, body: ReleaseRequest): Promise<{ released: number }> {
  const subjectId = optionalText(body.subjectId, 80);
  if (!subjectId) {
    throw new HeadshotRequestError(400, "subjectId is required to release a headshot.");
  }
  const released = await mutateCache((cache) => releaseSubject(cache, gameId, subjectId));
  return { released };
}

async function createPendingUniqueEntry(gameId: number, input: NormalizedHeadshotInput): Promise<HeadshotCacheEntry> {
  const prompt = buildPrompt(input);
  const now = new Date().toISOString();
  const entry: HeadshotCacheEntry = {
    id: randomUUID(),
    poolKey: `unique__${randomUUID()}`,
    role: input.role,
    race: input.race,
    sex: input.sex,
    age: input.age,
    clothing: input.clothing,
    createdAt: now,
    updatedAt: now,
    model: DEFAULT_MODEL,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "pending",
    unique: true,
    uses: [{
      gameId,
      subjectId: input.subjectId,
      claimedAt: now,
    }],
  };

  await mutateCache((cache) => {
    cache.entries.push(entry);
  });

  return entry;
}

async function generatePendingEntry(entryId: string, input: NormalizedHeadshotInput): Promise<void> {
  try {
    const prompt = buildPrompt(input);
    const image = await generateImage(getApiKey(), prompt, input);
    const extension = extensionFor(image.mimeType);
    const fileName = `${entryId}${extension}`;
    await ensureCacheDirs();
    await writeFile(join(IMAGE_DIR, fileName), image.bytes);
    await mutateCache((cache) => {
      const entry = cache.entries.find((item) => item.id === entryId);
      if (!entry) return;
      entry.fileName = fileName;
      entry.mimeType = image.mimeType;
      entry.status = "ready";
      entry.error = undefined;
      entry.updatedAt = new Date().toISOString();
    });
  } catch (error) {
    await mutateCache((cache) => {
      const entry = cache.entries.find((item) => item.id === entryId);
      if (!entry) return;
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : "Headshot generation failed.";
      entry.updatedAt = new Date().toISOString();
    });
  }
}

async function createCachedEntry(apiKey: string, input: NormalizedHeadshotInput): Promise<HeadshotCacheEntry> {
  const prompt = buildPrompt(input);
  const image = await generateImage(apiKey, prompt, input);
  const id = randomUUID();
  const extension = extensionFor(image.mimeType);
  const fileName = `${id}${extension}`;
  await ensureCacheDirs();
  await writeFile(join(IMAGE_DIR, fileName), image.bytes);
  const now = new Date().toISOString();

  return {
    id,
    poolKey: poolKey(input),
    role: input.role,
    race: input.race,
    sex: input.sex,
    age: input.age,
    clothing: input.clothing,
    fileName,
    mimeType: image.mimeType,
    createdAt: now,
    updatedAt: now,
    model: DEFAULT_MODEL,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "ready",
    unique: false,
    uses: [],
  };
}

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to generate a new headshot. Cached headshots can still be reused without it.");
  }
  return apiKey;
}

async function generateImage(
  apiKey: string,
  prompt: string,
  input: Pick<NormalizedHeadshotInput, "size" | "quality">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const payload = {
    model: DEFAULT_MODEL,
    prompt,
    n: 1,
    size: input.size,
    quality: input.quality,
    output_format: DEFAULT_OUTPUT_FORMAT,
  };

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }

  const json = await response.json() as OpenAIImageResponse;
  const image = json.data?.[0];
  if (image?.b64_json) {
    return {
      bytes: Buffer.from(image.b64_json, "base64"),
      mimeType: mimeFor(DEFAULT_OUTPUT_FORMAT),
    };
  }

  if (image?.url) {
    const imageResponse = await fetch(image.url);
    if (!imageResponse.ok) throw new Error(`Generated image download failed (${imageResponse.status}).`);
    return {
      bytes: Buffer.from(await imageResponse.arrayBuffer()),
      mimeType: imageResponse.headers.get("content-type") ?? mimeFor(DEFAULT_OUTPUT_FORMAT),
    };
  }

  throw new Error("OpenAI image response did not include image data.");
}

function buildPrompt(input: NormalizedHeadshotInput): string {
  const role = rolePrompt(input.role);
  const clothing = input.clothing
    ? `Clothing: ${input.clothing}.`
    : `Clothing: ${role.clothing}.`;
  const raceGuidance = input.race === "alien"
    ? "Species design: humanoid alien with original, elegant sci-fi facial features, expressive eyes, believable skin texture, not horror, not monstrous, not a mask or helmet."
    : "Species design: human, grounded facial structure, believable skin texture, natural expression.";

  return [
    "Create one original fictional character headshot for Ledgway, a sci-fi spreadsheet trading sim.",
    "Style: consistent dark cinematic space-station concept art, semi-realistic digital painting, subtle painterly texture, cool industrial lighting, restrained teal and amber accents, polished game portrait.",
    `Subject: ${identityDescription(input)} ${input.role}. Unique fictional face, not resembling any real person or celebrity.`,
    `Identity details: race ${input.race}; age band ${input.age}; sex or gender presentation ${input.sex}. Show the age band naturally through facial structure and styling, without caricature.`,
    raceGuidance,
    `Role identity: the character must read unmistakably as a ${input.role}, not a generic crew portrait.`,
    `Set and background: ${role.background}.`,
    `Props and frame details: ${role.props}.`,
    `Pose and expression: ${role.posture}.`,
    `Lighting: ${role.lighting}.`,
    clothing,
    "Composition: square portrait, head and upper shoulders, camera-facing or slight three-quarter view, face unobscured, no helmet visor.",
    "Do not include text, logos, watermarks, UI, badges with writing, extra people, gore, or weapons pointed at the viewer.",
  ].join("\n");
}

function identityDescription(input: Pick<NormalizedHeadshotInput, "age" | "race" | "sex">): string {
  return `${input.age} ${input.sex} ${input.race}`;
}

function rolePrompt(role: string) {
  const prompt = ROLE_PROMPTS[role];
  if (!prompt) throw new Error(`Missing headshot prompt for role: ${role}.`);
  return prompt;
}

function parseHeadshotInput(body: HeadshotRequest): NormalizedHeadshotInput {
  const role = requireOneOf(body.role, ROLES, "role");
  const race = requireOneOf(body.race, RACES, "race");
  const sex = requireOneOf(body.sex, SEXES, "sex");
  const age = requireOneOf(body.age, AGES, "age");
  const clothing = optionalText(body.clothing, 120);
  const subjectId = optionalText(body.subjectId, 80);
  return {
    role,
    race,
    sex,
    age,
    clothing: clothing || undefined,
    subjectId: subjectId || undefined,
    quality: DEFAULT_QUALITY,
    size: DEFAULT_SIZE,
  };
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string") {
    throw new HeadshotRequestError(400, `${label} is required. Allowed: ${allowed.join(", ")}.`);
  }

  const text = value.trim();
  const match = allowed.find((item) => item === text);
  if (!match) {
    throw new HeadshotRequestError(400, `Invalid ${label}: ${text}. Allowed: ${allowed.join(", ")}.`);
  }
  return match;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HeadshotRequestError(400, "clothing must be a string.");
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length > maxLength) {
    throw new HeadshotRequestError(400, `clothing must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function poolKey(input: NormalizedHeadshotInput): string {
  return [
    slug(input.role),
    input.race,
    input.sex,
    slug(input.age),
    input.quality,
    input.size,
    PROMPT_VERSION,
  ].join("__");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function matchesPoolSettings(entry: HeadshotCacheEntry, input: NormalizedHeadshotInput): boolean {
  return !entry.unique
    && entry.status === "ready"
    && entry.poolKey === poolKey(input)
    && (entry.promptVersion ?? 1) === PROMPT_VERSION;
}

function countUnusedEntries(cache: HeadshotCache, input: NormalizedHeadshotInput): number {
  return cache.entries
    .filter((entry) => matchesPoolSettings(entry, input))
    .filter(isUnusedEntry)
    .length;
}

function schedulePoolRefill(input: NormalizedHeadshotInput, available: number) {
  if (available > POOL_LOW_WATERMARK) return { queued: false, available };

  const key = poolKey(input);
  if (activeRefills.has(key)) return { queued: false, pending: true, available };

  activeRefills.add(key);
  void refillHeadshotPool({ ...input }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  }).finally(() => {
    activeRefills.delete(key);
  });

  return { queued: true, available, target: POOL_REFILL_COUNT };
}

async function refillHeadshotPool(input: NormalizedHeadshotInput): Promise<void> {
  // Insert pending pool entries under the cache lock so the next
  // allocate sees them as already-pending; then run generation outside
  // the lock so the vite middleware queue isn't held up.
  const pendingIds = await mutateCache((cache) => {
    if (countUnusedEntries(cache, input) > POOL_LOW_WATERMARK) return [] as string[];
    const ids: string[] = [];
    for (let index = 0; index < POOL_REFILL_COUNT; index += 1) {
      const entry = createPendingPoolRefillEntry(input);
      cache.entries.push(entry);
      ids.push(entry.id);
    }
    return ids;
  });
  for (const id of pendingIds) {
    void generatePendingEntry(id, input);
  }
}

function createPendingPoolRefillEntry(input: NormalizedHeadshotInput): HeadshotCacheEntry {
  const prompt = buildPrompt(input);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    poolKey: poolKey(input),
    role: input.role,
    race: input.race,
    sex: input.sex,
    age: input.age,
    clothing: input.clothing,
    createdAt: now,
    updatedAt: now,
    model: DEFAULT_MODEL,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "pending",
    unique: false,
    uses: [],
  };
}

function findReusableEntry(cache: HeadshotCache, input: NormalizedHeadshotInput, gameId: number, subjectId?: string): HeadshotCacheEntry | null {
  // Same (game, subject) hitting the same pool key always gets back the
  // entry it already owns — keeps a crew member's face stable across
  // re-renders and reloads. We check this *before* filtering by status so
  // a pending entry mid-generation is returned to subsequent polls
  // instead of triggering a duplicate generation.
  const existingForSubject = cache.entries.find((entry) =>
    matchesPoolKey(entry, input)
    && entry.status !== "failed"
    && entry.uses.some((use) => use.gameId === gameId && use.subjectId === subjectId)
  );
  if (existingForSubject) return existingForSubject;

  const candidates = cache.entries
    .filter((entry) => matchesPoolSettings(entry, input))
    .filter(isUnusedEntry);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function matchesPoolKey(entry: HeadshotCacheEntry, input: NormalizedHeadshotInput): boolean {
  return !entry.unique
    && entry.poolKey === poolKey(input)
    && (entry.promptVersion ?? 1) === PROMPT_VERSION;
}

function isUnusedEntry(entry: HeadshotCacheEntry): boolean {
  return entry.status === "ready" && entry.uses.length === 0;
}

function claimForGame(entry: HeadshotCacheEntry, gameId: number, subjectId?: string): boolean {
  if (entry.uses.some((use) => use.gameId === gameId && use.subjectId === subjectId)) return false;
  entry.uses.push({
    gameId,
    subjectId,
    claimedAt: new Date().toISOString(),
  });
  return true;
}

function releaseSubject(cache: HeadshotCache, gameId: number, subjectId: string): number {
  let removed = 0;
  for (const entry of cache.entries) {
    const before = entry.uses.length;
    entry.uses = entry.uses.filter((use) => !(use.gameId === gameId && use.subjectId === subjectId));
    removed += before - entry.uses.length;
  }
  return removed;
}

function matchesQuery(entry: HeadshotCacheEntry, params: URLSearchParams): boolean {
  const role = params.get("role");
  if (role && entry.role !== role) return false;
  const race = params.get("race");
  if (race && entry.race !== race) return false;
  const sex = params.get("sex");
  if (sex && entry.sex !== sex) return false;
  const age = params.get("age");
  if (age && entry.age !== age) return false;
  return true;
}

function parseGameRoute(pathname: string): { gameId: number; action: string } | null {
  const match = pathname.match(/^\/api\/headshots\/(\d+)\/([a-z-]+)$/);
  if (!match) return null;
  return { gameId: Number(match[1]), action: match[2] ?? "" };
}

function toClientEntry(entry: HeadshotCacheEntry) {
  return {
    id: entry.id,
    poolKey: entry.poolKey,
    role: entry.role,
    race: entry.race,
    sex: entry.sex,
    age: entry.age,
    clothing: entry.clothing,
    imageUrl: `/api/headshots/image/${entry.id}`,
    statusUrl: `/api/headshots/status/${entry.id}`,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    model: entry.model,
    size: entry.size,
    quality: entry.quality,
    promptVersion: entry.promptVersion ?? 1,
    status: entry.status,
    unique: entry.unique,
    error: entry.error,
    uses: entry.uses,
    available: isUnusedEntry(entry),
  };
}

function toClientGeneratedEntry(options: {
  id: string;
  input: NormalizedHeadshotInput;
  mimeType: string;
  imageUrl: string;
}) {
  return {
    id: options.id,
    poolKey: poolKey(options.input),
    role: options.input.role,
    race: options.input.race,
    sex: options.input.sex,
    age: options.input.age,
    clothing: options.input.clothing,
    imageUrl: options.imageUrl,
    statusUrl: `/api/headshots/status/${options.id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: DEFAULT_MODEL,
    size: options.input.size,
    quality: options.input.quality,
    promptVersion: PROMPT_VERSION,
    status: "ready",
    unique: true,
    uses: [],
    available: true,
    mimeType: options.mimeType,
  };
}

async function readCache(): Promise<HeadshotCache> {
  await ensureCacheDirs();
  try {
    const raw = await readFile(CACHE_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as HeadshotCache;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return { version: CACHE_VERSION, entries: [] };
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: CACHE_VERSION, entries: [] };
    }
    throw error;
  }
}

async function writeCache(cache: HeadshotCache): Promise<void> {
  await ensureCacheDirs();
  await writeFile(CACHE_INDEX_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function mutateCache<T>(mutator: (cache: HeadshotCache) => T | Promise<T>): Promise<T> {
  const result = cacheMutationQueue.then(async () => {
    const cache = await readCache();
    const value = await mutator(cache);
    await writeCache(cache);
    return value;
  });
  cacheMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureCacheDirs(): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true });
}

async function serveHeadshotStatus(pathname: string, res: ServerResponse): Promise<void> {
  const id = basename(pathname);
  const cache = await readCache();
  const entry = cache.entries.find((item) => item.id === id);
  if (!entry) {
    sendError(res, 404, "Headshot not found.");
    return;
  }
  sendJson(res, entry.status === "pending" ? 202 : entry.status === "failed" ? 500 : 200, { entry: toClientEntry(entry) });
}

async function serveHeadshotImage(pathname: string, res: ServerResponse, headOnly = false): Promise<void> {
  const id = basename(pathname);
  const cache = await readCache();
  const entry = cache.entries.find((item) => item.id === id);
  if (!entry) {
    sendError(res, 404, "Headshot not found.");
    return;
  }

  if (entry.status === "pending") {
    if (headOnly) {
      res.statusCode = 202;
      setCorsHeaders(res);
      res.end();
      return;
    }
    sendJson(res, 202, { entry: toClientEntry(entry) });
    return;
  }

  if (entry.status === "failed") {
    sendError(res, 500, entry.error ?? "Headshot generation failed.");
    return;
  }

  if (!entry.fileName || !entry.mimeType) {
    sendError(res, 500, "Headshot image file is not ready.");
    return;
  }

  const imagePath = join(IMAGE_DIR, entry.fileName);
  res.statusCode = 200;
  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(imagePath).on("error", () => {
    if (!res.headersSent) sendError(res, 404, "Headshot image file is missing.");
    else res.destroy();
  }).pipe(res);
}

function mimeFor(format: string): string {
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function extensionFor(mimeType: string): string {
  const ext = extname(mimeType.split(";")[0] ?? "");
  if (ext) return ext;
  if (mimeType.includes("jpeg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  return ".png";
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  setCorsHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
