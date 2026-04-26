import type { LocationDef, LocationId, Position, World } from "../types";
import { createWorld } from "../world";
import { ARCHETYPE_BUILDERS, ARCHETYPE_NAMES, type ArchetypeName } from "./archetypes";
import { generateName } from "./names";
import { mulberry32, pick, rangeFloat, type Rng } from "./rng";
import { generateTraders, locationsHaveAntimatter } from "./traders";

export interface GenerateWorldOptions {
  seed: number;
  locationCount: number;
  traderCount?: number;
  mapRadius?: number;
}

const ARCHETYPE_MIX: { archetype: ArchetypeName; weight: number }[] = [
  { archetype: "trade-hub",         weight: 0.15 },
  { archetype: "mining-belt",       weight: 0.25 },
  { archetype: "agricultural-ring", weight: 0.25 },
  { archetype: "frontier-outpost",  weight: 0.25 },
  { archetype: "research-station",  weight: 0.10 },
];

const RADIAL_BIAS: Record<ArchetypeName, [number, number]> = {
  "trade-hub":         [0.0, 0.4],
  "mining-belt":       [0.2, 0.7],
  "agricultural-ring": [0.2, 0.7],
  "frontier-outpost":  [0.6, 1.0],
  "research-station":  [0.0, 1.0],
};

function pickArchetypeMix(rng: Rng, count: number): ArchetypeName[] {
  const result: ArchetypeName[] = [];
  if (count >= 1) result.push("trade-hub");
  if (count >= 2) result.push("mining-belt");
  if (count >= 3) result.push("agricultural-ring");
  for (let i = result.length; i < count; i++) {
    const r = rng();
    let acc = 0;
    let chosen: ArchetypeName = "frontier-outpost";
    for (const entry of ARCHETYPE_MIX) {
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
    const position = i === 0 ? { x: 0, y: 0 } : randomPosition(rng, archetype, mapRadius);
    const { name, id } = generateName(rng, archetype, usedIds);
    locations[id] = ARCHETYPE_BUILDERS[archetype]({ rng, id, name, position });
  }

  const traders = generateTraders({
    rng,
    count: traderCount,
    locations,
    antimatterAvailable: locationsHaveAntimatter(locations),
  });

  return createWorld({ locations, lanes: {}, traders });
}
