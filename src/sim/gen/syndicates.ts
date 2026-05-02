import type { Syndicate, SyndicateId, SyndicateTraitId } from "../types";
import { SYNDICATE_ACCENTS, SYNDICATE_NAMES, SYNDICATE_TRAITS } from "../data/syndicates";
import { type Rng } from "./rng";

// Fixed 10:1 stations-to-syndicates ratio. Floors clamp to keep tiny test
// worlds from generating zero or every-station-is-an-outpost scenarios:
// at least 1 non-outpost station has to remain, and we need at least one
// syndicate to make the system meaningful (single-syndicate worlds still
// work — the boundary system just has nothing to contend with).
export function syndicateCountFor(stationCount: number): number {
  if (stationCount <= 1) return 0;
  const target = Math.round(stationCount / 10);
  return Math.max(1, Math.min(stationCount - 1, target));
}

// Build the roster of syndicates for a fresh world. The outpostId on
// each entry is left undefined here — the world generator fills it in
// once the seat-of-power outpost is placed for each syndicate.
//
// Names, traits, and accents are drawn without replacement from fixed
// pools so two syndicates in the same world never collide.
export function generateSyndicates(rng: Rng, stationCount: number): Syndicate[] {
  const count = syndicateCountFor(stationCount);
  if (count === 0) return [];
  const names = [...SYNDICATE_NAMES];
  const accents = [...SYNDICATE_ACCENTS];
  const traitIds = Object.keys(SYNDICATE_TRAITS) as SyndicateTraitId[];
  const result: Syndicate[] = [];
  for (let i = 0; i < count; i++) {
    const id: SyndicateId = `syn_${i + 1}`;
    const name = takeRandom(rng, names) ?? `Syndicate ${i + 1}`;
    const traitId = takeRandom(rng, traitIds);
    const accentHex = takeRandom(rng, accents) ?? "#9bb6c8";
    result.push({
      id,
      name,
      memberShipIds: [],
      treasury: 0,
      recentRevenue: 0,
      traitId,
      accentHex,
    });
  }
  return result;
}

function takeRandom<T>(rng: Rng, pool: T[]): T | undefined {
  if (pool.length === 0) return undefined;
  const idx = Math.floor(rng() * pool.length);
  return pool.splice(idx, 1)[0];
}
