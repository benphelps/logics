import type { Player, Trader } from "../types";

export interface PlayerSeedConfig {
  startingFunds: number;
  startingLocation: string;
  startingShipName: string;
}

export const DEFAULT_PLAYER_SEED: PlayerSeedConfig = {
  startingFunds: 55_000,                  // initial ship wallet; each ship is financially independent
  startingLocation: "haven",
  startingShipName: "Voyager",
};

export function makeStartingShip(name: string, location: string, funds: number): Trader {
  return {
    id: "p_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    name,
    capacity: 60,
    speed: 1,
    fuelCapacity: 60,
    fuelTypes: [{ good: "plasma", perDistance: 1.0 }],
    currentFuel: { good: "plasma", qty: 60 },
    funds,
    location,
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "manual",
    log: [],
  };
}

export function makePlayer(seed: PlayerSeedConfig = DEFAULT_PLAYER_SEED): {
  player: Player;
  ship: Trader;
} {
  const ship = makeStartingShip(seed.startingShipName, seed.startingLocation, seed.startingFunds);
  // player.funds remains in the type for back-compat / future personal-bank
  // features, but no sim flow reads or writes it now — each ship pays its own
  // way. Keep at 0 to make that explicit.
  const player: Player = {
    funds: 0,
    shipIds: [ship.id],
  };
  return { player, ship };
}
