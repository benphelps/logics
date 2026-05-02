import type { LocationId, World } from "./types";
import { DEFAULT_PLAYER_SEED, makePlayer } from "./data/player";
import { generateWorld } from "./gen/world";
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

  const startingLocation = opts.startingLocation && world.locations[opts.startingLocation]
    ? opts.startingLocation
    : choosePlayerStart(world);
  const made = makePlayer({
    startingFunds: opts.startingFunds ?? DEFAULT_PLAYER_SEED.startingFunds,
    startingLocation,
    startingShipName: opts.startingShipName ?? DEFAULT_PLAYER_SEED.startingShipName,
  });
  world.traders[made.ship.id] = made.ship;
  world.player = made.player;
  return world;
}
