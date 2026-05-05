// Spawn cadence + bias bookkeeping for the on-demand news system.
//
// The simulator no longer composes events directly — it just decides "we
// want a new event right now, here's the target tier and a bias hint" and
// the UI layer fires an async request to /api/news/event. When the response
// lands, applyResolvedNewsEvent stamps the resolved event into world state
// (active list + recent ring + bias EMA).
//
// Mean-reversion bias is preserved exactly as before: each effect nudges
// state.bias[scopeKey], it decays each tick, and when the spawn picks a
// target the bias state is consulted to suggest a direction the LLM should
// lean (favor_negative / favor_positive).

import type { World } from "../types";
import { mulberry32, type Rng } from "../gen/rng";
import type {
  ActiveNewsEvent,
  NewsEffect,
  NewsEventsState,
  NewsTarget,
  NewsTone,
} from "./types";

export const NEWS_SPAWN_PERIOD = 30;       // roll for spawn every N ticks
export const NEWS_SPAWN_CHANCE = 0.4;      // probability of a spawn on each cadence roll
export const MAX_ACTIVE_EVENTS = 12;
export const MAX_INFLIGHT_REQUESTS = 2;
export const BIAS_DECAY = 0.995;
export const NEWS_SEED_SALT = 0x9E3779B1;

// Default split: most news leans toward escalation / risk-up so the sector
// feels lived in. The bias state can pull toward the other side as
// mean-reversion kicks in.
const BASE_FAVOR_NEGATIVE = 0.6;

const COST_SCOPES = new Set([
  "maintenance", "crew_wage", "docking_fee",
  "commodity_price", "upgrade_cost",
]);

export type NewsBiasHint = "favor_negative" | "favor_positive" | "neutral";

export interface NewsSpawnRequest {
  // Target the event should affect. Maps directly to NewsTarget.
  target: NewsTarget;
  // Friendly label the prompt builder can drop into LLM context. Optional;
  // server falls back to ids when absent.
  label?: string;
  // The bias hint the LLM should lean toward — encodes both the spawn-time
  // direction roll and any mean-reverting pressure from the bias state.
  biasHint: NewsBiasHint;
  // Diagnostic — which tier the picker chose. Useful for testing /
  // telemetry but not load-bearing.
  tier: "world" | "sector" | "station" | "good";
}

function rngFor(world: World): Rng {
  const id = world.newsEvents?.nextEventId ?? 1;
  return mulberry32((((world.tick + 1) * 0x12345) ^ id ^ NEWS_SEED_SALT) | 0);
}

export function decayBias(state: NewsEventsState): void {
  for (const key of Object.keys(state.bias)) {
    const next = state.bias[key] * BIAS_DECAY;
    if (Math.abs(next) < 1e-4) delete state.bias[key];
    else state.bias[key] = next;
  }
}

// --- spawn cadence -------------------------------------------------------

export function maybeQueueNewsRequest(world: World): NewsSpawnRequest | null {
  const state = world.newsEvents;
  if (!state || !state.enabled) return null;
  if (state.active.length >= MAX_ACTIVE_EVENTS) return null;
  if ((state.pendingRequestCount ?? 0) >= MAX_INFLIGHT_REQUESTS) return null;
  if (world.tick === 0) return null;
  if (world.tick % NEWS_SPAWN_PERIOD !== 0) return null;

  const rng = rngFor(world);
  if (rng() >= NEWS_SPAWN_CHANCE) return null;

  const tier = pickTier(rng);
  const targetSpec = pickTargetForTier(world, tier, rng);
  if (!targetSpec) return null;

  const biasHint = pickBiasHint(state, targetSpec.target, rng);

  return {
    target: targetSpec.target,
    label: targetSpec.label,
    biasHint,
    tier,
  };
}

// Tier roll. Stations are the most common target (each station gets news
// often), goods next (commodity drama), sector less often (regional shifts),
// world events are rare but big.
function pickTier(rng: Rng): NewsSpawnRequest["tier"] {
  const r = rng();
  if (r < 0.05) return "world";
  if (r < 0.20) return "sector";
  if (r < 0.55) return "good";
  return "station";
}

function pickTargetForTier(
  world: World,
  tier: NewsSpawnRequest["tier"],
  rng: Rng,
): { target: NewsTarget; label?: string } | null {
  switch (tier) {
    case "world":
      return { target: { kind: "global" }, label: "the entire sector" };
    case "sector": {
      const synds = Object.values(world.syndicates);
      if (synds.length === 0) return null;
      const synd = synds[Math.floor(rng() * synds.length)];
      // "Sector" tier targets all locations in the syndicate's territory
      // via the location-category match in the modifier layer.
      return {
        target: { kind: "location", category: synd.id },
        label: `${synd.name} space`,
      };
    }
    case "station": {
      const stations = Object.values(world.locations);
      if (stations.length === 0) return null;
      const loc = stations[Math.floor(rng() * stations.length)];
      return { target: { kind: "location", id: loc.id }, label: loc.name };
    }
    case "good": {
      const goods = Object.values(world.goods);
      if (goods.length === 0) return null;
      const good = goods[Math.floor(rng() * goods.length)];
      return { target: { kind: "good", id: good.id }, label: good.name };
    }
  }
}

// Bias hint = base favor_negative roll, nudged by the bias state for the
// target. If the target's bias is strongly positive (lots of recent
// escalation), we favor positive (de-escalation) on this roll, and vice
// versa — mean-reverting pressure.
function pickBiasHint(state: NewsEventsState, target: NewsTarget, rng: Rng): NewsBiasHint {
  const targetBias = sampleTargetBias(state, target);
  // targetBias is in approx [-0.5, 0.5]. Subtract from 0.5 baseline so a
  // strongly-positive bias drags the threshold down (more chance of
  // favor_positive being picked).
  const threshold = clamp(BASE_FAVOR_NEGATIVE - targetBias * 0.4, 0.2, 0.85);
  if (rng() < threshold) return "favor_negative";
  return "favor_positive";
}

function sampleTargetBias(state: NewsEventsState, target: NewsTarget): number {
  // Average all bias entries that match this target's id/category. Cheap
  // approximation — we don't have a per-target bias bucket, only per
  // (scope, target) pair. Aggregating across scopes is a usable signal.
  let sum = 0;
  let n = 0;
  for (const [key, value] of Object.entries(state.bias)) {
    const parts = key.split("|");
    if (parts.length < 3) continue;
    const targetId = parts[2];
    if (target.kind === "global") {
      if (targetId === "*") { sum += value; n += 1; }
      continue;
    }
    if (target.id && targetId === target.id) { sum += value; n += 1; }
    else if (target.category && targetId === target.category) { sum += value; n += 1; }
  }
  return n > 0 ? sum / n : 0;
}

// --- response application -------------------------------------------------
// Called by the UI layer when /api/news/event lands. The model returns a
// pre-resolved event (effects with concrete targets + magnitudes), we just
// finalize it: stamp uid, push to active, update bias.

export interface ResolvedNewsEvent {
  headline: string;
  body: string;
  tone?: string;
  category?: string;
  durationBand?: "short" | "medium" | "long";
  magnitudeBand?: "low" | "medium" | "high";
  effects: NewsEffect[];
}

const DURATION_BANDS: Record<"short" | "medium" | "long", [number, number]> = {
  short: [60, 120], medium: [120, 300], long: [300, 600],
};

export function applyResolvedNewsEvent(
  world: World,
  resolved: ResolvedNewsEvent,
): ActiveNewsEvent | null {
  const state = world.newsEvents;
  if (!state || !state.enabled) return null;
  if (state.active.length >= MAX_ACTIVE_EVENTS) return null;

  const effects = resolved.effects.filter(e => e.scope && (e.target.kind === "global" || e.target.id || e.target.category));
  if (effects.length === 0) return null;

  const durationBand = resolved.durationBand ?? "medium";
  const [durMin, durMax] = DURATION_BANDS[durationBand];
  const rng = mulberry32((world.tick + state.nextEventId) | 0);
  const duration = Math.max(10, Math.floor(durMin + (durMax - durMin) * rng()));

  const ev: ActiveNewsEvent = {
    uid: `news-${state.nextEventId}`,
    templateId: `gen-${state.nextEventId}`,    // synthetic id since events are 1:1 generated
    spawnedAt: world.tick,
    expiresAt: world.tick + duration,
    effects,
    headline: resolved.headline,
    body: resolved.body,
    category: resolved.category ?? "trade",
    tone: validTone(resolved.tone),
  };
  state.active.push(ev);
  state.nextEventId += 1;
  for (const eff of effects) {
    const key = biasKey(eff);
    state.bias[key] = (state.bias[key] ?? 0) + eff.direction * eff.magnitude;
  }
  return ev;
}

function validTone(tone: string | undefined): NewsTone {
  if (tone === "good" || tone === "bad" || tone === "warn" || tone === "info") return tone;
  return "info";
}

function biasKey(eff: NewsEffect): string {
  return `${eff.scope}|${eff.target.kind}|${eff.target.id ?? eff.target.category ?? "*"}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Re-export so existing callers (UI) stay backwards compat for tone hints.
export { COST_SCOPES };
