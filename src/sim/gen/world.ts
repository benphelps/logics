import { euclidean } from "../geometry";
import type { LaneMap, LocationDef, LocationId, Player, Position, World } from "../types";
import { createWorld } from "../world";
import type { PlayerSeedConfig } from "../data/player";
import { ARCHETYPE_BUILDERS, type ArchetypeName } from "./archetypes";
import { generateName } from "./names";
import { mulberry32, rangeFloat, type Rng } from "./rng";
import { generateTraders, locationsHaveAntimatter } from "./traders";

export interface GenerateWorldOptions {
  seed: number;
  locationCount: number;
  traderCount?: number;
  mapRadius?: number;
  player?: Player | null | PlayerSeedConfig;
}

const ARCHETYPE_MIX: { archetype: ArchetypeName; weight: number }[] = [
  { archetype: "trade-hub",         weight: 0.13 },
  { archetype: "mining-belt",       weight: 0.23 },
  { archetype: "agricultural-ring", weight: 0.23 },
  { archetype: "frontier-outpost",  weight: 0.24 },
  { archetype: "research-station",  weight: 0.10 },
  { archetype: "shipyard",          weight: 0.07 },
];

const RADIAL_BIAS: Record<ArchetypeName, [number, number]> = {
  "trade-hub":         [0.0, 0.4],
  "mining-belt":       [0.2, 0.7],
  "agricultural-ring": [0.2, 0.7],
  "frontier-outpost":  [0.6, 1.0],
  "research-station":  [0.0, 1.0],
  // Shipyards sit well outside the rim — dedicated yards on the edge of
  // settled space so they don't crowd the lane network and the trip
  // to one feels intentional.
  "shipyard":          [0.95, 1.15],
};

// Minimum distance any shipyard must keep from every other station, in
// the same map-radius units the position generator uses. Roughly twice
// the typical inter-station spacing in a 50-station world; we re-roll
// (or push outward) until the constraint is satisfied.
const SHIPYARD_MIN_SEPARATION = 4.5;

// At least one shipyard per world (so the player always has somewhere to
// buy a ship), then ~1 per 18 stations beyond. Capped so big worlds don't
// get spammed.
function shipyardQuotaFor(count: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(4, Math.round(count / 18)));
}

function pickArchetypeMix(rng: Rng, count: number): ArchetypeName[] {
  const result: ArchetypeName[] = [];
  if (count >= 1) result.push("trade-hub");
  if (count >= 2) result.push("mining-belt");
  if (count >= 3) result.push("agricultural-ring");
  // Reserve fixed slots for shipyards so a low-count world still has at
  // least one. Subtracted from the weighted draw below.
  const shipyardQuota = Math.min(shipyardQuotaFor(count), Math.max(0, count - result.length));
  for (let i = 0; i < shipyardQuota; i++) result.push("shipyard");
  for (let i = result.length; i < count; i++) {
    const r = rng();
    let acc = 0;
    let chosen: ArchetypeName = "frontier-outpost";
    for (const entry of ARCHETYPE_MIX) {
      // Shipyard slots are already reserved; skip the weighted slot to
      // avoid double-allocating.
      if (entry.archetype === "shipyard") continue;
      acc += entry.weight;
      if (r < acc) { chosen = entry.archetype; break; }
    }
    result.push(chosen);
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function randomPosition(rng: Rng, archetype: ArchetypeName, mapRadius: number): Position {
  const [minR, maxR] = RADIAL_BIAS[archetype];
  const r = rangeFloat(rng, minR, maxR) * mapRadius;
  const theta = rangeFloat(rng, 0, Math.PI * 2);
  return { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
}

// Pick a position for `archetype`, enforcing the shipyard isolation
// constraint when it applies. For non-shipyards, behaves like
// randomPosition. For shipyards, retries until the candidate is at
// least SHIPYARD_MIN_SEPARATION away from every existing station; if
// retries are exhausted, falls back to the furthest candidate seen.
function placeArchetype(
  rng: Rng,
  archetype: ArchetypeName,
  mapRadius: number,
  existing: Record<LocationId, LocationDef>,
): Position {
  if (archetype !== "shipyard") return randomPosition(rng, archetype, mapRadius);
  const placed = Object.values(existing).map(l => l.position);
  if (placed.length === 0) return randomPosition(rng, archetype, mapRadius);
  let best: { pos: Position; minDist: number } | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = randomPosition(rng, archetype, mapRadius);
    let minDist = Infinity;
    for (const p of placed) {
      const d = Math.hypot(candidate.x - p.x, candidate.y - p.y);
      if (d < minDist) minDist = d;
    }
    if (minDist >= SHIPYARD_MIN_SEPARATION) return candidate;
    if (!best || minDist > best.minDist) best = { pos: candidate, minDist };
  }
  // Couldn't satisfy the strict constraint — return the most isolated
  // candidate we saw rather than failing world generation.
  return best!.pos;
}

function routeModifier(a: LocationDef, b: LocationDef): number {
  const tags = new Set([...a.traits.tags, ...b.traits.tags]);
  const tech = (a.traits.techLevel + b.traits.techLevel) / 2;
  let modifier = 1.0;
  if (tags.has("trade-hub")) modifier -= 0.10;
  if (tech >= 8) modifier -= 0.04;
  if (tags.has("frontier") || tags.has("rim")) modifier += 0.06;
  return Math.max(0.78, Math.min(1.12, Number(modifier.toFixed(2))));
}

function addRoute(lanes: LaneMap, a: LocationDef, b: LocationDef): boolean {
  if (a.id === b.id) return false;
  lanes[a.id] ??= {};
  lanes[b.id] ??= {};
  if (lanes[a.id][b.id] != null || lanes[b.id][a.id] != null) return false;
  const modifier = routeModifier(a, b);
  lanes[a.id][b.id] = modifier;
  lanes[b.id][a.id] = modifier;
  return true;
}

function routeDegree(lanes: LaneMap, id: LocationId): number {
  const direct = new Set(Object.keys(lanes[id] ?? {}));
  for (const [from, edges] of Object.entries(lanes)) {
    if (edges[id] != null) direct.add(from);
  }
  direct.delete(id);
  return direct.size;
}

export function generateRoutes(locations: Record<LocationId, LocationDef>): LaneMap {
  const ids = Object.keys(locations) as LocationId[];
  const lanes: LaneMap = {};
  for (const id of ids) lanes[id] = {};
  if (ids.length <= 1) return lanes;

  const connected = new Set<LocationId>([ids[0]]);
  const remaining = new Set<LocationId>(ids.slice(1));
  while (remaining.size > 0) {
    let best: { a: LocationId; b: LocationId; dist: number } | null = null;
    for (const a of connected) {
      for (const b of remaining) {
        const dist = euclidean(locations[a].position, locations[b].position);
        if (!best || dist < best.dist) best = { a, b, dist };
      }
    }
    if (!best) break;
    addRoute(lanes, locations[best.a], locations[best.b]);
    connected.add(best.b);
    remaining.delete(best.b);
  }

  for (const id of ids) {
    const loc = locations[id];
    const targetDegree = loc.traits.tags.includes("trade-hub")
      ? 5
      : loc.traits.tags.includes("research") || loc.traits.tags.includes("industrial")
        ? 4
        : loc.traits.tags.includes("frontier") || loc.traits.tags.includes("rim")
          ? 2
          : 3;
    const nearest = ids
      .filter(other => other !== id)
      .map(other => ({ id: other, dist: euclidean(loc.position, locations[other].position) }))
      .sort((a, b) => a.dist - b.dist);
    for (const n of nearest) {
      if (routeDegree(lanes, id) >= targetDegree) break;
      addRoute(lanes, loc, locations[n.id]);
    }
  }

  const hubs = ids.filter(id => locations[id].traits.tags.includes("trade-hub"));
  for (const id of hubs) {
    const loc = locations[id];
    const nearestHubs = hubs
      .filter(other => other !== id)
      .map(other => ({ id: other, dist: euclidean(loc.position, locations[other].position) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2);
    for (const hub of nearestHubs) addRoute(lanes, loc, locations[hub.id]);
  }

  return lanes;
}

export function generateWorld(opts: GenerateWorldOptions): World {
  const rng = mulberry32(opts.seed);
  const locationCount = Math.max(1, opts.locationCount);
  const mapRadius = opts.mapRadius ?? Math.max(8, Math.sqrt(locationCount) * 4);
  const traderCount = opts.traderCount ?? Math.max(2, Math.round(locationCount * 1.5));

  const archetypes = pickArchetypeMix(rng, locationCount);
  const usedIds = new Set<string>();
  const locations: Record<LocationId, LocationDef> = {};

  for (let i = 0; i < locationCount; i++) {
    const archetype = archetypes[i];
    const position = i === 0
      ? { x: 0, y: 0 }
      : placeArchetype(rng, archetype, mapRadius, locations);
    const { name, id } = generateName(rng, archetype, usedIds);
    locations[id] = ARCHETYPE_BUILDERS[archetype]({ rng, id, name, position });
  }

  const lanes = generateRoutes(locations);
  const traders = generateTraders({
    rng,
    count: traderCount,
    locations,
    antimatterAvailable: locationsHaveAntimatter(locations),
  });

  return createWorld({ locations, lanes, traders, player: opts.player ?? null });
}
