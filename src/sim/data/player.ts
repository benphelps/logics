import type { Player, Trader } from "../types";

export interface PlayerSeedConfig {
  startingFunds: number;
  startingLocation: string;
  startingShipName: string;
}

export const DEFAULT_PLAYER_SEED: PlayerSeedConfig = {
  startingFunds: 50_000,
  startingLocation: "haven",
  startingShipName: "Voyager",
};

export function makeStartingShip(name: string, location: string): Trader {
  return {
    id: "p_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    name,
    capacity: 60,
    speed: 1,
    fuelCapacity: 60,
    fuelTypes: [{ good: "plasma", perDistance: 1.0 }],
    currentFuel: { good: "plasma", qty: 60 },
    funds: 5_000,
    location,
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "manual",
  };
}

export function makePlayer(seed: PlayerSeedConfig = DEFAULT_PLAYER_SEED): {
  player: Player;
  ship: Trader;
} {
  const ship = makeStartingShip(seed.startingShipName, seed.startingLocation);
  const player: Player = {
    funds: seed.startingFunds,
    shipIds: [ship.id],
  };
  return { player, ship };
}
