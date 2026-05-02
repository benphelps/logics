import { euclidean } from "../geometry";
import type { LaneMap, LocationDef, LocationId, Player, Position, Syndicate, SyndicateId, World } from "../types";
import { createWorld } from "../world";
import type { PlayerSeedConfig } from "../data/player";
import { ARCHETYPE_BUILDERS, type ArchetypeName } from "./archetypes";
import { generateName } from "./names";
import { mulberry32, rangeFloat, type Rng } from "./rng";
import { generateSyndicates } from "./syndicates";
import { seedControlFromFactions } from "../control";
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
  // Syndicate outposts seat the inner-to-mid disc; their positions are
  // re-rolled to enforce inter-outpost separation so each one anchors
  // its own cluster instead of sharing space with a rival's HQ.
  "syndicate-outpost": [0.0, 0.6],
};

// Minimum distance any shipyard must keep from every other station, in
// the same map-radius units the position generator uses. Roughly twice
// the typical inter-station spacing in a 50-station world; we re-roll
// (or push outward) until the constraint is satisfied.
const SHIPYARD_MIN_SEPARATION = 4.5;

// Minimum distance any clustered station has to keep from every prior
// station — applied via rejection sampling in placeNearOutpost. Set as
// a fraction of mapRadius so it scales with world size, and tuned so
// the projected atlas always has visible space between station glyphs
// (no overlap, room for docked-ship dots, room for lane endpoints).
const CLUSTER_MIN_SEPARATION_FACTOR = 0.12;

// Cluster offset by archetype, expressed as a fraction of mapRadius. Each
// non-outpost station is placed at an isotropic offset from its parent
// outpost drawn from this range — small for trade-hubs (orbit the seat),
// far for frontier-outposts (the cluster's rim). Ranges are spread out
// to keep inner/middle/outer rings layered: trade-hubs sit close in,
// mining/agri/research fill the middle ring, frontier sits on the rim.
const CLUSTER_OFFSET: Partial<Record<ArchetypeName, [number, number]>> = {
  "trade-hub":         [0.12, 0.25],
  "mining-belt":       [0.22, 0.42],
  "agricultural-ring": [0.22, 0.42],
  "frontier-outpost":  [0.40, 0.70],
  "research-station":  [0.22, 0.42],
};

// At least one shipyard per world (so the player always has somewhere to
// buy a ship), then ~1 per 18 stations beyond. Capped so big worlds don't
// get spammed.
function shipyardQuotaFor(count: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(4, Math.round(count / 18)));
}

function pickArchetypeMix(rng: Rng, count: number, outpostCount: number): ArchetypeName[] {
  const result: ArchetypeName[] = [];
  // Syndicate outposts come first — one per syndicate, capped by total
  // station budget. World gen relies on these slots being present so it
  // can place them as seeds before clustering anything else.
  const outpostBudget = Math.min(outpostCount, count);
  for (let i = 0; i < outpostBudget; i++) result.push("syndicate-outpost");
  if (result.length < count) result.push("trade-hub");
  if (result.length < count) result.push("mining-belt");
  if (result.length < count) result.push("agricultural-ring");
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
  // Don't shuffle outposts into the middle — gen places them first as
  // cluster seeds, then walks the rest of the list. Shuffle only the
  // tail so the mix of trade-hubs / mining / agri / frontier / research
  // remains random per cluster.
  const head = result.slice(0, outpostBudget);
  const tail = result.slice(outpostBudget);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return [...head, ...tail];
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

// Place a syndicate outpost. Inner-disc bias plus a min-separation pass
// keeps the seats of power spread apart, so the clusters that grow
// around them don't immediately overlap. The minimum separation scales
// with the number of outposts; the constant is tuned wide enough that
// each cluster's outer-ring stations (frontier, ~0.7 of mapRadius
// from the seat) don't crash into neighbouring clusters.
function placeOutpost(
  rng: Rng,
  mapRadius: number,
  totalOutposts: number,
  placed: Position[],
): Position {
  const minSep = totalOutposts > 1 ? mapRadius * (2.4 / Math.sqrt(totalOutposts)) : 0;
  let best: { pos: Position; minDist: number } | null = null;
  for (let attempt = 0; attempt < 48; attempt++) {
    const candidate = randomPosition(rng, "syndicate-outpost", mapRadius);
    let minDist = Infinity;
    for (const p of placed) {
      const d = Math.hypot(candidate.x - p.x, candidate.y - p.y);
      if (d < minDist) minDist = d;
    }
    if (placed.length === 0 || minDist >= minSep) return candidate;
    if (!best || minDist > best.minDist) best = { pos: candidate, minDist };
  }
  return best!.pos;
}

// Place a non-outpost, non-shipyard station near its parent outpost.
// Offset distribution is archetype-specific (see CLUSTER_OFFSET) — close
// for trade-hubs, far for frontier-outposts — so every cluster ends up
// with a layered structure: hub at the seat, mining/agri in the middle
// ring, frontier on the cluster's rim.
//
// Rejection-samples until the candidate is at least
// CLUSTER_MIN_SEPARATION_FACTOR × mapRadius away from every already-
// placed station; falls back to the most-isolated candidate seen if
// the constraint can't be hit within the budget. This is what stops
// clusters from collapsing into illegible piles on the atlas.
function placeNearOutpost(
  rng: Rng,
  archetype: ArchetypeName,
  mapRadius: number,
  parent: Position,
  existing: Record<LocationId, LocationDef>,
): Position {
  const range = CLUSTER_OFFSET[archetype] ?? [0.10, 0.40];
  const minSep = mapRadius * CLUSTER_MIN_SEPARATION_FACTOR;
  const placed = Object.values(existing).map(l => l.position);
  let best: { pos: Position; minDist: number } | null = null;
  for (let attempt = 0; attempt < 32; attempt++) {
    const r = rangeFloat(rng, range[0], range[1]) * mapRadius;
    const theta = rangeFloat(rng, 0, Math.PI * 2);
    const candidate = { x: parent.x + Math.cos(theta) * r, y: parent.y + Math.sin(theta) * r };
    if (placed.length === 0) return candidate;
    let minDist = Infinity;
    for (const p of placed) {
      const d = Math.hypot(candidate.x - p.x, candidate.y - p.y);
      if (d < minDist) minDist = d;
    }
    if (minDist >= minSep) return candidate;
    if (!best || minDist > best.minDist) best = { pos: candidate, minDist };
  }
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

  const syndicateRoster = generateSyndicates(rng, locationCount);
  const archetypes = pickArchetypeMix(rng, locationCount, syndicateRoster.length);
  const usedIds = new Set<string>();
  const locations: Record<LocationId, LocationDef> = {};

  // Pass 1: place syndicate outposts as cluster seeds. Each outpost
  // occupies a head slot in the archetype list (pickArchetypeMix
  // guarantees the order). They're stamped with their owning syndicate
  // immediately so the nearest-outpost faction stamp in pass 3 is a
  // pure proximity classifier.
  const outpostSeeds: { syndicateId: SyndicateId; position: Position }[] = [];
  let cursor = 0;
  while (cursor < archetypes.length && archetypes[cursor] === "syndicate-outpost" && cursor < syndicateRoster.length) {
    const synd = syndicateRoster[cursor];
    // Anchor the first-placed outpost at origin — keeps the world's
    // coordinate system centered on a real station so centrality
    // calculations (player-start ranking, etc.) have a stable pivot.
    const position = outpostSeeds.length === 0
      ? { x: 0, y: 0 }
      : placeOutpost(rng, mapRadius, syndicateRoster.length, outpostSeeds.map(o => o.position));
    const { name, id } = generateName(rng, "syndicate-outpost", usedIds);
    const def = ARCHETYPE_BUILDERS["syndicate-outpost"]({ rng, id, name, position });
    def.traits.faction = synd.id;
    locations[id] = def;
    synd.outpostId = id;
    outpostSeeds.push({ syndicateId: synd.id, position });
    cursor++;
  }

  // Pass 2: place every remaining station. Shipyards keep their isolated
  // rim placement; everything else attaches to a parent outpost. Picks
  // the LEAST-BUSY outpost rather than a random one — uniform random
  // assignment lets some clusters get 12 stations while others get 4,
  // which is what produced the dense pile-ups in the centre.
  const parentLoad = outpostSeeds.map(() => 0);
  for (let i = cursor; i < archetypes.length; i++) {
    const archetype = archetypes[i];
    let position: Position;
    if (archetype === "shipyard" || outpostSeeds.length === 0) {
      position = placeArchetype(rng, archetype, mapRadius, locations);
    } else {
      let pickIdx = 0;
      for (let p = 1; p < outpostSeeds.length; p++) {
        if (parentLoad[p] < parentLoad[pickIdx]) pickIdx = p;
      }
      parentLoad[pickIdx] += 1;
      const parent = outpostSeeds[pickIdx];
      position = placeNearOutpost(rng, archetype, mapRadius, parent.position, locations);
    }
    const { name, id } = generateName(rng, archetype, usedIds);
    locations[id] = ARCHETYPE_BUILDERS[archetype]({ rng, id, name, position });
  }

  // Pass 3: stamp faction on every station that didn't get one from its
  // builder. Shipyards stay independent — they're cross-faction service
  // hubs by design. Every other station joins the syndicate of its
  // nearest outpost, which produces the same clusters players will see
  // on the atlas as control bubbles.
  for (const loc of Object.values(locations)) {
    if (loc.traits.faction) continue;
    if (loc.traits.tags.includes("shipyard")) continue;
    if (outpostSeeds.length === 0) continue;
    let nearest = outpostSeeds[0];
    let bestDist = euclidean(loc.position, nearest.position);
    for (let i = 1; i < outpostSeeds.length; i++) {
      const d = euclidean(loc.position, outpostSeeds[i].position);
      if (d < bestDist) { bestDist = d; nearest = outpostSeeds[i]; }
    }
    loc.traits.faction = nearest.syndicateId;
  }

  const lanes = generateRoutes(locations);
  const traders = generateTraders({
    rng,
    count: traderCount,
    locations,
    antimatterAvailable: locationsHaveAntimatter(locations),
  });

  // Faction-stamp every NPC. The default is the home station's owning
  // syndicate; shipyard-based NPCs (whose home is intentionally
  // unfactioned) are split round-robin so each syndicate's roster stays
  // roughly balanced. Done here, before createWorld, so memberShipIds is
  // populated by the time ensureStockMarket reads syndicate wealth.
  if (syndicateRoster.length > 0) {
    let stray = 0;
    for (const trader of Object.values(traders)) {
      const home = locations[trader.location];
      if (home?.traits.faction) {
        trader.syndicateId = home.traits.faction;
      } else {
        trader.syndicateId = syndicateRoster[stray % syndicateRoster.length].id;
        stray++;
      }
    }
  }

  const syndicates: Record<SyndicateId, Syndicate> = {};
  for (const synd of syndicateRoster) {
    synd.memberShipIds = Object.values(traders)
      .filter(t => t.syndicateId === synd.id)
      .map(t => t.id);
    syndicates[synd.id] = synd;
  }

  const world = createWorld({ locations, lanes, traders, syndicates, player: opts.player ?? null });
  // Seed each station's control map with full ownership to its assigned
  // syndicate. Per-tick decay and activity-driven nudges take it from
  // here. Gen-time seeding keeps the renderer's first-paint identical
  // to the legacy "everyone at 100%" behaviour.
  seedControlFromFactions(world);
  return world;
}
