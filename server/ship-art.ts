// Ship-art generation endpoint. Mirrors the headshots image-gen
// pipeline at a much smaller scope: ship art is keyed on (class,
// family, traits-hash, sizing) so the cache is tiny and there's no
// per-game allocation to manage. Each call POST /api/ship-art/generate
// returns a fresh image via the OpenAI Images API; cached entries are
// served from /api/ship-art/image/:id like the headshots route.
//
// Prompt language follows ART_WORKFLOW.md: subtle UI info-card
// backdrop, distant ship in upper third, dark lower band for text,
// cool industrial palette. Per-class and per-family detail blocks
// adapt the silhouette and surface treatment.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import type { Plugin } from "vite";

type Quality = "low" | "medium" | "high";
type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export type ShipArtClass = "freighter" | "courier" | "hauler" | "cruiser" | "exotic";
export type ShipArtFamily = ShipArtClass | "scout" | "tanker";
export type ShipArtTrait =
  | "self-piloted"
  | "ai-navigator"
  | "extra-slot"
  | "fuel-efficient"
  | "rapid-unload";

export type ImageProvider = "openai" | "gemini";

interface ShipArtRequest {
  class?: string;
  family?: string;
  name?: string;
  traits?: string[];
  flavor?: string;
  size?: string;
  quality?: string;
  provider?: string;
}

interface NormalizedShipArtInput {
  class: ShipArtClass;
  family: ShipArtFamily;
  name?: string;
  traits: ShipArtTrait[];
  flavor?: string;
  size: ImageSize;
  quality: Quality;
  provider: ImageProvider;
}

interface ShipArtCacheEntry {
  id: string;
  poolKey: string;
  class: ShipArtClass;
  family: ShipArtFamily;
  traits: ShipArtTrait[];
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

interface ShipArtCache {
  version: 1;
  entries: ShipArtCacheEntry[];
}

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

interface GeminiImagenResponse {
  // Imagen ":predict" shape — paid plan only.
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
  }>;
}

interface GeminiContentResponse {
  // gemini-2.5-flash-image ":generateContent" shape — multimodal,
  // image bytes ride along inside a part's inlineData (or inline_data
  // depending on response casing). Free-tier eligible.
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

const CACHE_VERSION = 1;
const CACHE_ROOT = resolve(process.cwd(), process.env.SHIP_ART_CACHE_DIR ?? ".logics-cache/ship-art");
const CACHE_INDEX_PATH = join(CACHE_ROOT, "index.json");
const IMAGE_DIR = join(CACHE_ROOT, "images");
const DEFAULT_OPENAI_MODEL = process.env.SHIP_ART_OPENAI_MODEL ?? process.env.SHIP_ART_IMAGE_MODEL ?? "gpt-image-1.5";
// Default to Gemini's free-tier multimodal image model. Imagen is
// gated behind a paid plan and returns 400 ("Imagen is only available
// on paid plans") on free-tier keys; gemini-2.5-flash-image works
// everywhere via the generateContent endpoint. Override with
// SHIP_ART_GEMINI_MODEL=imagen-4.0-generate-001 once a paid key is
// available — the request dispatcher detects the imagen prefix and
// switches to the :predict shape automatically.
const DEFAULT_GEMINI_MODEL = process.env.SHIP_ART_GEMINI_MODEL ?? "gemini-2.5-flash-image";
const DEFAULT_OUTPUT_FORMAT = process.env.SHIP_ART_IMAGE_FORMAT ?? "webp";
const DEFAULT_QUALITY: Quality = "low";
const DEFAULT_SIZE: ImageSize = "1536x1024";
// Default provider for in-game ship-art generation. OpenAI's
// gpt-image-1.5 produces consistently usable info-card backdrops at
// the requested pixel size with no fake-UI text leakage. Override
// with SHIP_ART_PROVIDER=gemini (or via per-request `provider`) for
// the faster but model-picked-size Gemini Flash Image path.
const DEFAULT_PROVIDER: ImageProvider = (process.env.SHIP_ART_PROVIDER === "gemini" ? "gemini" : "openai");
const PROMPT_VERSION = 1;

const QUALITIES: Quality[] = ["low", "medium", "high"];
const SIZES: ImageSize[] = ["1024x1024", "1024x1536", "1536x1024"];
const CLASSES: ShipArtClass[] = ["freighter", "courier", "hauler", "cruiser", "exotic"];
const FAMILIES: ShipArtFamily[] = [...CLASSES, "scout", "tanker"];
const TRAITS: ShipArtTrait[] = ["self-piloted", "ai-navigator", "extra-slot", "fuel-efficient", "rapid-unload"];
const PROVIDERS: ImageProvider[] = ["openai", "gemini"];

// Maps our pixel sizes to the closest Imagen aspect ratio. Imagen
// doesn't accept arbitrary pixel dimensions — it picks a preset
// aspect ratio at a fixed render resolution. Square and 3:2 / 2:3
// cover the three sizes we already accept for OpenAI.
const GEMINI_ASPECT_BY_SIZE: Record<ImageSize, string> = {
  "1024x1024": "1:1",
  "1024x1536": "9:16",
  "1536x1024": "16:9",
};

let cacheMutationQueue = Promise.resolve();

class ShipArtRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CLASS_PROMPTS: Record<ShipArtClass, {
  silhouette: string;
  surface: string;
  scale: string;
  vibe: string;
}> = {
  freighter: {
    silhouette: "balanced mid-tonnage freighter — squared cargo modules amidships, twin nacelles slung underneath, blunt utilitarian prow",
    surface: "weathered painted plating, identification stripes faded, clean panel seams without readable text",
    scale: "mid-distance side-quarter view, the ship occupies the upper half of the frame",
    vibe: "workhorse trader, dependable, not glamorous",
  },
  courier: {
    silhouette: "slim courier hull — narrow cockpit nose, compact mid-fuselage, single oversized thrust block at the tail",
    surface: "smooth low-friction skin, faint heat-bloom along the spine, recessed sensor blisters",
    scale: "three-quarter angled profile, the ship reads as small and quick against deep space",
    vibe: "fast, light, runs hot",
  },
  hauler: {
    silhouette: "heavy hauler — massive bulk-cargo spine, multi-strut keel, wide engine cluster trailing the cargo train",
    surface: "industrial unpainted hull plates, mag-rail rib cage, dust-stained chevron warning bands without writing",
    scale: "long lateral profile filling the width of the frame, dwarfs the implied dock infrastructure",
    vibe: "slow on the burn, brutal on the manifest",
  },
  cruiser: {
    silhouette: "armored cruiser — reinforced spine, two flush dorsal hardpoints, angled flight deck, tapered stern with cooling vents",
    surface: "matte combat plating, subtle ablative panel grid, recessed turret housings with no muzzles visible",
    scale: "front-three-quarter view, ship sits in the upper third with negative space below for UI overlays",
    vibe: "built to come back from runs no one else came back from",
  },
  exotic: {
    silhouette: "experimental exotic — asymmetric hull, unconventional thrust geometry, exposed instrumentation rings, soft blue or violet trim glow",
    surface: "polished prototype skin, subtle chromatic shimmer, hand-fabricated panel work, recessed running lights",
    scale: "off-center distant shot, framing leaves room for atmospheric haze and an under-lit foreground",
    vibe: "half lab specimen, half ship — the kind that thinks for itself",
  },
};

const FAMILY_FALLBACK_PROMPTS: Record<Exclude<ShipArtFamily, ShipArtClass>, {
  silhouette: string;
  surface: string;
  scale: string;
  vibe: string;
}> = {
  scout: {
    silhouette: "agile scout — single-pilot cockpit forward, slender wings folded close, twin micro-thrusters at the rear",
    surface: "matte stealth coating, recessed sensor windows, no visible weaponry",
    scale: "distant glinting silhouette across a dark sky, the ship occupies a small portion of the upper third",
    vibe: "quiet, watchful, light on its feet",
  },
  tanker: {
    silhouette: "spherical fuel cells lashed to a long central truss, broad maneuvering thrusters at the bow",
    surface: "thick insulation panels, color-coded valve clusters with no readable labels, frost-edged seams",
    scale: "lateral profile, the curved cell silhouette dominates the upper half",
    vibe: "slow, vital, treated like cargo with extra rules",
  },
};

const TRAIT_PROMPTS: Record<ShipArtTrait, string> = {
  "self-piloted": "soft autopilot indicator glow on the underside, no visible cockpit canopy",
  "ai-navigator": "thin holographic plotting trace projected from the bow, subtle violet rim light",
  "extra-slot": "an additional dorsal hardpoint visible mid-spine",
  "fuel-efficient": "extended trim foils trailing the engines for low-burn travel",
  "rapid-unload": "twin cargo gantry arms clipped along the flank, ready to swing out at dock",
};

export function shipArtDevServerPlugin(): Plugin {
  return {
    name: "logics-ship-art-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleShipArtRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          sendError(res, error instanceof ShipArtRequestError ? error.status : 500, error instanceof Error ? error.message : "Unexpected ship-art server error.");
        });
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleShipArtRequest(req, res).then((handled) => {
          if (!handled) next();
        }).catch((error: unknown) => {
          sendError(res, error instanceof ShipArtRequestError ? error.status : 500, error instanceof Error ? error.message : "Unexpected ship-art server error.");
        });
      });
    },
  };
}

export async function handleShipArtRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/ship-art")) return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ship-art/options") {
    sendJson(res, 200, {
      classes: CLASSES,
      families: FAMILIES,
      traits: TRAITS,
      qualities: QUALITIES,
      sizes: SIZES,
      providers: PROVIDERS,
      defaultProvider: DEFAULT_PROVIDER,
      promptVersion: PROMPT_VERSION,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ship-art/cache") {
    const cache = await readCache();
    sendJson(res, 200, { entries: cache.entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toClientEntry) });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/ship-art/status/")) {
    await serveShipArtStatus(url.pathname, res);
    return true;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/ship-art/image/")) {
    await serveShipArtImage(url.pathname, res, req.method === "HEAD");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ship-art/generate") {
    const result = await generateShipArt(parseShipArtInput(await readJsonBody<ShipArtRequest>(req)));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ship-art/for-ship") {
    const result = await getOrCreateShipArt(parseShipArtInput(await readJsonBody<ShipArtRequest>(req)));
    sendJson(res, 200, result);
    return true;
  }

  sendError(res, 404, "Unknown ship-art API route.");
  return true;
}

// Lookup-or-pending flow used by the in-game ship info panels. Unlike
// /api/ship-art/generate, this returns immediately with an entry
// pointer the client can poll: a cache hit is "cache + ready", a brand
// new request is "pending" and gets generated in the background. Lets
// the panel render a static fallback while the OpenAI/Gemini call is
// in flight, then swap to the generated image once it lands.
async function getOrCreateShipArt(input: NormalizedShipArtInput) {
  const key = poolKey(input);
  const existing = await mutateCache((cache) => cache.entries.find((e) => e.poolKey === key && e.status !== "failed") ?? null);
  if (existing) {
    return {
      source: existing.status === "ready" ? "cache" as const : "pending" as const,
      entry: toClientEntry(existing),
    };
  }
  // Mint a new pending entry under the cache lock so a duplicate
  // request from another panel landing in the same tick reuses it
  // instead of double-generating.
  const id = randomUUID();
  const prompt = buildShipArtPrompt(input);
  const model = modelFor(input.provider);
  const now = new Date().toISOString();
  const pending: ShipArtCacheEntry = {
    id,
    poolKey: key,
    class: input.class,
    family: input.family,
    traits: input.traits,
    createdAt: now,
    updatedAt: now,
    model,
    provider: input.provider,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "pending",
  };
  await mutateCache((cache) => { cache.entries.push(pending); });
  // Fire-and-forget the upstream call. Errors update the entry to
  // status="failed" so the polling client sees the failure.
  void generatePendingEntry(id, input).catch(() => undefined);
  return {
    source: "pending" as const,
    entry: toClientEntry(pending),
  };
}

async function generatePendingEntry(id: string, input: NormalizedShipArtInput): Promise<void> {
  const prompt = buildShipArtPrompt(input);
  try {
    const image = await generateImage(prompt, input);
    const ext = extensionFor(image.mimeType);
    const fileName = `${id}${ext}`;
    await ensureCacheDirs();
    await writeFile(join(IMAGE_DIR, fileName), image.bytes);
    await mutateCache((cache) => {
      const found = cache.entries.find((e) => e.id === id);
      if (!found) return;
      found.fileName = fileName;
      found.mimeType = image.mimeType;
      found.status = "ready";
      found.updatedAt = new Date().toISOString();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ship-art generation failed.";
    await mutateCache((cache) => {
      const found = cache.entries.find((e) => e.id === id);
      if (!found) return;
      found.status = "failed";
      found.error = message;
      found.updatedAt = new Date().toISOString();
    });
  }
}

async function generateShipArt(input: NormalizedShipArtInput) {
  const prompt = buildShipArtPrompt(input);
  const model = modelFor(input.provider);
  const id = randomUUID();
  const now = new Date().toISOString();
  const entry: ShipArtCacheEntry = {
    id,
    poolKey: poolKey(input),
    class: input.class,
    family: input.family,
    traits: input.traits,
    createdAt: now,
    updatedAt: now,
    model,
    provider: input.provider,
    size: input.size,
    quality: input.quality,
    promptVersion: PROMPT_VERSION,
    prompt,
    status: "pending",
  };
  await mutateCache((cache) => { cache.entries.push(entry); });

  try {
    const image = await generateImage(prompt, input);
    const ext = extensionFor(image.mimeType);
    const fileName = `${id}${ext}`;
    await ensureCacheDirs();
    await writeFile(join(IMAGE_DIR, fileName), image.bytes);
    await mutateCache((cache) => {
      const found = cache.entries.find((e) => e.id === id);
      if (!found) return;
      found.fileName = fileName;
      found.mimeType = image.mimeType;
      found.status = "ready";
      found.updatedAt = new Date().toISOString();
    });
    return {
      source: "generated" as const,
      entry: toClientEntry({ ...entry, fileName, mimeType: image.mimeType, status: "ready" }),
      prompt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ship-art generation failed.";
    await mutateCache((cache) => {
      const found = cache.entries.find((e) => e.id === id);
      if (!found) return;
      found.status = "failed";
      found.error = message;
      found.updatedAt = new Date().toISOString();
    });
    throw new ShipArtRequestError(500, message);
  }
}

function modelFor(provider: ImageProvider): string {
  return provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENAI_MODEL;
}

function buildShipArtPrompt(input: NormalizedShipArtInput): string {
  const block = CLASS_PROMPTS[input.class] ?? FAMILY_FALLBACK_PROMPTS[input.family as keyof typeof FAMILY_FALLBACK_PROMPTS];
  if (!block) throw new ShipArtRequestError(400, `No prompt block for class ${input.class} / family ${input.family}.`);
  const traitLines = input.traits.map((t) => `  · ${TRAIT_PROMPTS[t]}`).filter(Boolean);
  const traitBlock = traitLines.length > 0 ? `\nVisible perks (subtle, no text labels):\n${traitLines.join("\n")}` : "";
  const flavorLine = input.flavor ? `\nFlavor cue: ${input.flavor}` : "";
  const nameLine = input.name ? `\nShip identity hint (non-text): ${input.name} — informs proportions and silhouette personality only; the image must NOT include readable hull markings.` : "";

  return [
    "Create a subtle faded UI info-card background image for Logics, a sci-fi spreadsheet trading sim.",
    "Style: dark cinematic space-station concept art, semi-realistic digital painting, painterly texture, cool industrial lighting, restrained teal and amber accents, polished game backdrop.",
    `Subject class: ${input.class}.`,
    `Silhouette: ${block.silhouette}.`,
    `Surface treatment: ${block.surface}.`,
    `Framing: ${block.scale}.`,
    `Vibe: ${block.vibe}.`,
    traitBlock,
    flavorLine,
    nameLine,
    "Composition: wide cinematic framing, subject in upper third / upper half, lower third dark and quiet for UI overlays. Avoid: text, logos, signage, UI elements, characters, close-up cockpit, huge planet, overbright bloom.",
  ].filter(Boolean).join("\n");
}

function getOpenAIApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ShipArtRequestError(503, "OPENAI_API_KEY is required to generate ship art via OpenAI.");
  }
  return apiKey;
}

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new ShipArtRequestError(503, "GEMINI_API_KEY (or GOOGLE_API_KEY) is required to generate ship art via Gemini.");
  }
  return apiKey;
}

// Provider-aware dispatch. Each provider returns the same shape so the
// caller doesn't have to care which API ran the generation.
async function generateImage(
  prompt: string,
  input: Pick<NormalizedShipArtInput, "size" | "quality" | "provider">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (input.provider === "gemini") {
    return generateImageGemini(getGeminiApiKey(), prompt, input);
  }
  return generateImageOpenAI(getOpenAIApiKey(), prompt, input);
}

async function generateImageOpenAI(
  apiKey: string,
  prompt: string,
  input: Pick<NormalizedShipArtInput, "size" | "quality">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const payload = {
    model: DEFAULT_OPENAI_MODEL,
    prompt,
    n: 1,
    size: input.size,
    quality: input.quality,
    output_format: DEFAULT_OUTPUT_FORMAT,
  };
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  const json = await response.json() as OpenAIImageResponse;
  const image = json.data?.[0];
  if (image?.b64_json) {
    return { bytes: Buffer.from(image.b64_json, "base64"), mimeType: mimeFor(DEFAULT_OUTPUT_FORMAT) };
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

async function generateImageGemini(
  apiKey: string,
  prompt: string,
  input: Pick<NormalizedShipArtInput, "size">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  // Two distinct Google image APIs share this provider slot. Imagen
  // models (image generation as a paid product) speak the predict
  // payload shape; the gemini-*-image multimodal models speak the
  // generateContent payload shape. Detect by model name so users can
  // upgrade to Imagen by setting SHIP_ART_GEMINI_MODEL without any
  // other config.
  if (DEFAULT_GEMINI_MODEL.startsWith("imagen")) {
    return generateImageGeminiImagen(apiKey, prompt, input);
  }
  return generateImageGeminiContent(apiKey, prompt, input);
}

async function generateImageGeminiImagen(
  apiKey: string,
  prompt: string,
  input: Pick<NormalizedShipArtInput, "size">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const aspectRatio = GEMINI_ASPECT_BY_SIZE[input.size] ?? "1:1";
  const requestedMime = imageMimeForGoogle(DEFAULT_OUTPUT_FORMAT);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:predict`;
  const payload = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio, outputMimeType: requestedMime },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini Imagen generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  const json = await response.json() as GeminiImagenResponse;
  const prediction = json.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error("Gemini Imagen response did not include image data.");
  }
  return {
    bytes: Buffer.from(prediction.bytesBase64Encoded, "base64"),
    mimeType: prediction.mimeType ?? requestedMime,
  };
}

async function generateImageGeminiContent(
  apiKey: string,
  prompt: string,
  _input: Pick<NormalizedShipArtInput, "size">,
): Promise<{ bytes: Buffer; mimeType: string }> {
  // gemini-2.5-flash-image takes a free-form generateContent call and
  // returns the image as inline base64 inside a candidate part. The
  // model picks its own dimensions (currently ~1024-wide); aspect
  // hints have to ride in the prompt itself, which we already supply
  // via the framing line.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini image generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  const json = await response.json() as GeminiContentResponse;
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
  }
  for (const candidate of json.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      // Both casings appear in Gemini responses depending on the
      // SDK / version — read the camelCase one first, then the
      // snake_case shape.
      const inline = part.inlineData
        ? { mimeType: part.inlineData.mimeType, data: part.inlineData.data }
        : part.inline_data
          ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data }
          : null;
      if (inline?.data) {
        return {
          bytes: Buffer.from(inline.data, "base64"),
          mimeType: inline.mimeType ?? "image/png",
        };
      }
    }
  }
  throw new Error("Gemini response did not include image data.");
}

// Imagen / Gemini multimodal accept only image/png and image/jpeg.
// Map our webp default to png so requests still succeed; the cache
// writer reads the response's actual mimeType when stamping the
// extension on disk.
function imageMimeForGoogle(format: string): string {
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/png";
}

function parseShipArtInput(body: ShipArtRequest): NormalizedShipArtInput {
  const cls = requireOneOf(body.class, CLASSES, "class");
  // Family defaults to the class itself when absent — keeps the
  // common case (a freighter/courier/hauler/cruiser/exotic) ergonomic.
  const familyRaw = body.family ?? cls;
  const family = requireOneOf(familyRaw, FAMILIES, "family");
  const traitsRaw = Array.isArray(body.traits) ? body.traits : [];
  const traits: ShipArtTrait[] = [];
  for (const t of traitsRaw) {
    if (typeof t !== "string") continue;
    const match = TRAITS.find((x) => x === t);
    if (match) traits.push(match);
  }
  const name = optionalText(body.name, 60);
  const flavor = optionalText(body.flavor, 240);
  const size = body.size && SIZES.includes(body.size as ImageSize) ? body.size as ImageSize : DEFAULT_SIZE;
  const quality = body.quality && QUALITIES.includes(body.quality as Quality) ? body.quality as Quality : DEFAULT_QUALITY;
  const provider = body.provider && (PROVIDERS as readonly string[]).includes(body.provider)
    ? body.provider as ImageProvider
    : DEFAULT_PROVIDER;
  return { class: cls, family, traits, name, flavor, size, quality, provider };
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string") {
    throw new ShipArtRequestError(400, `${label} is required. Allowed: ${allowed.join(", ")}.`);
  }
  const text = value.trim();
  const match = allowed.find((item) => item === text);
  if (!match) {
    throw new ShipArtRequestError(400, `Invalid ${label}: ${text}. Allowed: ${allowed.join(", ")}.`);
  }
  return match;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length > maxLength) {
    throw new ShipArtRequestError(400, `Field exceeds ${maxLength} characters.`);
  }
  return text;
}

function poolKey(input: NormalizedShipArtInput): string {
  return [
    input.provider,
    input.class,
    input.family,
    [...input.traits].sort().join(","),
    input.size,
    input.quality,
    PROMPT_VERSION,
  ].join("__");
}

function toClientEntry(entry: ShipArtCacheEntry) {
  return {
    id: entry.id,
    poolKey: entry.poolKey,
    class: entry.class,
    family: entry.family,
    traits: entry.traits,
    imageUrl: entry.fileName ? `/api/ship-art/image/${entry.id}` : undefined,
    statusUrl: `/api/ship-art/status/${entry.id}`,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    model: entry.model,
    provider: entry.provider,
    size: entry.size,
    quality: entry.quality,
    promptVersion: entry.promptVersion,
    status: entry.status,
    error: entry.error,
  };
}

async function readCache(): Promise<ShipArtCache> {
  await ensureCacheDirs();
  try {
    const raw = await readFile(CACHE_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as ShipArtCache;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return { version: CACHE_VERSION, entries: [] };
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { version: CACHE_VERSION, entries: [] };
    }
    throw error;
  }
}

async function writeCache(cache: ShipArtCache): Promise<void> {
  await ensureCacheDirs();
  await writeFile(CACHE_INDEX_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function mutateCache<T>(mutator: (cache: ShipArtCache) => T | Promise<T>): Promise<T> {
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

async function serveShipArtStatus(pathname: string, res: ServerResponse): Promise<void> {
  const id = basename(pathname);
  const cache = await readCache();
  const entry = cache.entries.find((item) => item.id === id);
  if (!entry) {
    sendError(res, 404, "Ship-art entry not found.");
    return;
  }
  sendJson(res, entry.status === "pending" ? 202 : entry.status === "failed" ? 500 : 200, { entry: toClientEntry(entry) });
}

async function serveShipArtImage(pathname: string, res: ServerResponse, headOnly = false): Promise<void> {
  const id = basename(pathname);
  const cache = await readCache();
  const entry = cache.entries.find((item) => item.id === id);
  if (!entry) {
    sendError(res, 404, "Ship-art entry not found.");
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
    sendError(res, 500, entry.error ?? "Ship-art generation failed.");
    return;
  }
  if (!entry.fileName || !entry.mimeType) {
    sendError(res, 500, "Ship-art image file is not ready.");
    return;
  }
  const imagePath = join(IMAGE_DIR, entry.fileName);
  res.statusCode = 200;
  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (headOnly) { res.end(); return; }
  createReadStream(imagePath).on("error", () => {
    if (!res.headersSent) sendError(res, 404, "Ship-art image file is missing.");
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
