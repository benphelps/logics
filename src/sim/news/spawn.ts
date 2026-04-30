// Cadence-based event spawning with mean-reversion bias. Deterministic — RNG
// derived from world.tick + nextEventId so replays match.

import type { World } from "../types";
import { mulberry32, type Rng } from "../gen/rng";
import type {
  ActiveNewsEvent,
  NewsEffect,
  NewsEventTemplate,
  NewsEventsState,
  NewsTone,
} from "./types";

export const NEWS_SPAWN_PERIOD = 30;       // roll for spawn every N ticks
export const NEWS_SPAWN_CHANCE = 0.4;      // probability of a spawn on each cadence roll
export const MAX_ACTIVE_EVENTS = 12;
export const BIAS_DECAY = 0.995;
export const NEWS_SEED_SALT = 0x9E3779B1;

export const DURATION_BANDS: Record<"short" | "medium" | "long", [number, number]> = {
  short: [60, 120], medium: [120, 300], long: [300, 600],
};

export const MAGNITUDE_BANDS: Record<"low" | "medium" | "high", [number, number]> = {
  low: [0.05, 0.10], medium: [0.10, 0.18], high: [0.18, 0.25],
};

const PERSON_NAMES: readonly string[] = [
  "Captain Reyes", "Magistrate Aiyana", "Senator Vella", "Doctor Holm",
  "Foreman Brisby", "Ambassador Toure", "Inspector Pell", "Dean Otsuki",
  "Director Mara", "Procurator Lin", "Bishop Calder", "Cartel head Voss",
  "Investigator Park", "Engineer Fox", "Pirate-king Drago", "Prophet Auren",
  "Speaker Zinn", "Captain Mok", "Doctor Sato", "Steward Aldis",
];

const COST_SCOPES = new Set([
  "maintenance", "crew_wage", "docking_fee",
  "commodity_price", "upgrade_cost",
]);

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

export function maybeSpawnEvent(world: World, pool: NewsEventTemplate[]): ActiveNewsEvent | null {
  const state = world.newsEvents;
  if (!state || !state.enabled) return null;
  if (state.active.length >= MAX_ACTIVE_EVENTS) return null;
  if (pool.length === 0) return null;
  if (world.tick === 0) return null;
  if (world.tick % NEWS_SPAWN_PERIOD !== 0) return null;

  const rng = rngFor(world);
  if (rng() >= NEWS_SPAWN_CHANCE) return null;

  const candidates = pool.filter(t => effectsResolvable(world, t));
  if (candidates.length === 0) return null;

  const weights = candidates.map(t => weightFor(t, state.bias));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return null;

  let pick = rng() * total;
  let chosen = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    pick -= weights[i];
    if (pick <= 0) { chosen = candidates[i]; break; }
  }

  const ev = resolveTemplate(world, chosen, rng);
  if (!ev) return null;

  state.active.push(ev);
  state.nextEventId += 1;
  for (const eff of ev.effects) {
    const key = biasKey(eff);
    state.bias[key] = (state.bias[key] ?? 0) + eff.direction * eff.magnitude;
  }
  return ev;
}

function biasKey(eff: NewsEffect): string {
  return `${eff.scope}|${eff.target.kind}|${eff.target.id ?? eff.target.category ?? "*"}`;
}

// Templates whose net effect direction *opposes* current bias are weighted up.
function weightFor(t: NewsEventTemplate, bias: Record<string, number>): number {
  let netDir = 0;
  let netBias = 0;
  for (const eff of t.effects) {
    netDir += eff.direction * eff.magnitude;
    netBias += bias[biasKey(eff)] ?? 0;
  }
  // Opposing alignment (netDir and netBias have opposite signs) → product is
  // negative → weight > 1. Aligned → weight < 1. Tanh keeps everything bounded.
  const w = 1 - Math.tanh(netDir * netBias * 4);
  return Math.max(0.05, w);
}

function effectsResolvable(world: World, t: NewsEventTemplate): boolean {
  if (t.effects.length === 0) return false;
  for (const eff of t.effects) {
    const tgt = eff.target;
    if (tgt.kind === "good") {
      if (Object.keys(world.goods).length === 0) return false;
      if (tgt.id && !world.goods[tgt.id]) return false;
      if (tgt.category && !Object.values(world.goods).some(g => g.category === tgt.category)) return false;
    }
    if (tgt.kind === "location") {
      if (Object.keys(world.locations).length === 0) return false;
      if (tgt.id && !world.locations[tgt.id]) return false;
    }
    if (tgt.kind === "syndicate") {
      if (Object.keys(world.syndicates).length === 0) return false;
      if (tgt.id && !world.syndicates[tgt.id]) return false;
    }
    if (tgt.kind === "index") {
      if (tgt.id && !world.equities[tgt.id]) return false;
    }
  }
  return true;
}

function resolveTemplate(world: World, t: NewsEventTemplate, rng: Rng): ActiveNewsEvent | null {
  const state = world.newsEvents!;
  const stations = Object.values(world.locations);
  const goods = Object.values(world.goods);
  const syndicates = Object.values(world.syndicates);

  const station = stations.length > 0 ? stations[Math.floor(rng() * stations.length)] : null;
  // Honor effect target.category when picking a placeholder good.
  const goodCategoryHint = t.effects.find(e => e.target.kind === "good" && e.target.category)?.target.category;
  const goodCandidates = goodCategoryHint ? goods.filter(g => g.category === goodCategoryHint) : goods;
  const good = goodCandidates.length > 0
    ? goodCandidates[Math.floor(rng() * goodCandidates.length)]
    : null;
  const syndicate = syndicates.length > 0 ? syndicates[Math.floor(rng() * syndicates.length)] : null;
  const person = PERSON_NAMES[Math.floor(rng() * PERSON_NAMES.length)];

  const fill = (s: string): string => s
    .replace(/\{station\}/g, station?.name ?? "the colony")
    .replace(/\{good\}/g, good?.name ?? "supplies")
    .replace(/\{syndicate\}/g, syndicate?.name ?? "the consortium")
    .replace(/\{person\}/g, person);

  const [magMin, magMax] = MAGNITUDE_BANDS[t.magnitudeBand];

  const resolvedEffects: NewsEffect[] = t.effects.map(eff => {
    const target = { ...eff.target };
    if (!target.id && !target.category) {
      if (target.kind === "good"      && good)      target.id = good.id;
      if (target.kind === "location"  && station)   target.id = station.id;
      if (target.kind === "syndicate" && syndicate) target.id = syndicate.id;
    }
    // Template can pre-set magnitude (>0) to lock a specific value; otherwise
    // sample from the band.
    const sampled = magMin + (magMax - magMin) * rng();
    const magnitude = eff.magnitude > 0 ? eff.magnitude : sampled;
    return {
      scope: eff.scope,
      target,
      direction: eff.direction,
      magnitude: clamp(magnitude, 0.01, 0.30),
    };
  });

  // Reject if no effect has a usable target (unbound + non-global).
  const allUnbound = resolvedEffects.every(e => e.target.kind !== "global" && !e.target.id && !e.target.category);
  if (allUnbound) return null;

  const [durMin, durMax] = DURATION_BANDS[t.durationBand];
  const duration = Math.max(10, Math.floor(durMin + (durMax - durMin) * rng()));

  return {
    uid: `news-${state.nextEventId}`,
    templateId: t.id,
    spawnedAt: world.tick,
    expiresAt: world.tick + duration,
    effects: resolvedEffects,
    headline: fill(t.headline),
    body: fill(t.body),
    category: t.category,
    tone: inferTone(resolvedEffects),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function inferTone(effects: NewsEffect[]): NewsTone {
  let goodCount = 0, badCount = 0;
  for (const e of effects) {
    const isCost = COST_SCOPES.has(e.scope);
    const playerHelped = isCost ? e.direction < 0 : e.direction > 0;
    if (playerHelped) goodCount++;
    else badCount++;
  }
  if (badCount > goodCount) return "bad";
  if (goodCount > badCount) return "good";
  return "info";
}
