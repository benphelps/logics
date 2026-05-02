import type { LocationId, SyndicateId, World } from "./types";
import { DEFAULT_PLAYER_SEED, makePlayer } from "./data/player";
import { generateWorld } from "./gen/world";
import { recomputeShipStats } from "./crew";
import { SYNDICATE_TRAITS } from "./data/syndicates";
import { tickN } from "./tick";

export interface StartingWorldOptions {
  seed?: number;
  locationCount?: number;
  traderCount?: number;
  mapRadius?: number;
  ageTicks?: number;
  startingFunds?: number;
  startingLocation?: LocationId;
  startingShipName?: string;
  // The syndicate the player is joining — set by the new-game picker.
  // Stamped onto the player ship's syndicateId, and (when the syndicate
  // has an outpost) used as the default starting location so a fresh
  // game opens at the player's faction HQ.
  syndicateId?: SyndicateId;
}

export const DEFAULT_STARTING_WORLD = {
  locationCount: 50,
  traderCount: 100,
  ageTicks: 90,
} as const;

export function randomStartingWorldSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function centralityScore(world: World, id: LocationId): number {
  const loc = world.locations[id];
  if (!loc) return Number.POSITIVE_INFINITY;
  return Math.hypot(loc.position.x, loc.position.y);
}

export function choosePlayerStart(world: World): LocationId {
  const locations = Object.values(world.locations);
  const ranked = [...locations].sort((a, b) => {
    const aHub = a.traits.tags.includes("trade-hub") ? 0 : 1;
    const bHub = b.traits.tags.includes("trade-hub") ? 0 : 1;
    return aHub - bHub
      || centralityScore(world, a.id) - centralityScore(world, b.id)
      || b.population - a.population
      || b.traits.techLevel - a.traits.techLevel;
  });
  return ranked[0]?.id ?? "";
}

export function createStartingWorld(opts: StartingWorldOptions = {}): World {
  const locationCount = opts.locationCount ?? DEFAULT_STARTING_WORLD.locationCount;
  const world = generateWorld({
    seed: opts.seed ?? randomStartingWorldSeed(),
    locationCount,
    traderCount: opts.traderCount ?? DEFAULT_STARTING_WORLD.traderCount,
    mapRadius: opts.mapRadius,
    player: null,
  });

  const ageTicks = Math.max(0, Math.floor(opts.ageTicks ?? DEFAULT_STARTING_WORLD.ageTicks));
  if (ageTicks > 0) tickN(world, ageTicks);

  // When the player has joined a syndicate, default the starting station
  // to that syndicate's outpost (the seat of power). The explicit
  // startingLocation override still wins for tests and dev tools.
  const syndicate = opts.syndicateId ? world.syndicates[opts.syndicateId] : undefined;
  const factionStart = syndicate?.outpostId && world.locations[syndicate.outpostId]
    ? syndicate.outpostId
    : null;
  const startingLocation = opts.startingLocation && world.locations[opts.startingLocation]
    ? opts.startingLocation
    : factionStart ?? choosePlayerStart(world);
  const made = makePlayer({
    startingFunds: opts.startingFunds ?? DEFAULT_PLAYER_SEED.startingFunds,
    startingLocation,
    startingShipName: opts.startingShipName ?? DEFAULT_PLAYER_SEED.startingShipName,
  });
  if (opts.syndicateId) {
    made.ship.syndicateId = opts.syndicateId;
    const trait = syndicate?.traitId ? SYNDICATE_TRAITS[syndicate.traitId] : null;
    if (trait) {
      // Snapshot the trait's modifiers onto the ship and recompute stats
      // so the picker's promised cargo / speed / fuel bonus is reflected
      // immediately — without waiting for the first crew/upgrade event.
      made.ship.syndicateModifiers = { ...trait.modifiers };
      recomputeShipStats(made.ship);
    }
  }
  world.traders[made.ship.id] = made.ship;
  world.player = made.player;
  return world;
}
