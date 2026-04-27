import type { FuelType, Trader } from "../types";

const PLASMA_ONLY = (perDistance: number): FuelType[] => [
  { good: "plasma", perDistance },
];

const ANTIMATTER_HYBRID = (apd: number, ppd: number): FuelType[] => [
  { good: "antimatter", perDistance: apd },
  { good: "plasma",     perDistance: ppd },
];

export const STARTER_TRADERS: Record<string, Trader> = {
  t_pelican:   mk("t_pelican",   "Pelican",    60, 1, 30, PLASMA_ONLY(1.0),           "haven",    3),
  t_mantis:    mk("t_mantis",    "Mantis",     90, 1, 40, PLASMA_ONLY(1.2),           "ironhold", 4),
  t_kestrel:   mk("t_kestrel",   "Kestrel",    40, 2, 25, PLASMA_ONLY(0.9),           "verdant",  2),
  t_leviathan: mk("t_leviathan", "Leviathan", 120, 1, 60, ANTIMATTER_HYBRID(0.5, 1.4), "saffron",  5),
  t_falcon:    mk("t_falcon",    "Falcon",     50, 2, 30, ANTIMATTER_HYBRID(0.3, 0.8), "haven",    3),
  t_mule:      mk("t_mule",      "Mule",      100, 1, 50, PLASMA_ONLY(1.3),           "verdant",  4),
};

function mk(
  id: string,
  name: string,
  capacity: number,
  speed: number,
  fuelCapacity: number,
  fuelTypes: FuelType[],
  location: string,
  hull: number,
): Trader {
  const fallback = fuelTypes[fuelTypes.length - 1]!.good;
  return {
    id, name, capacity, speed,
    fuelCapacity,
    baseCapacity: capacity,
    baseSpeed: speed,
    baseFuelCapacity: fuelCapacity,
    baseHull: hull,
    baseWeaponPower: 0,
    hull,
    weaponPower: 0,
    upgrades: {},
    fuelTypes,
    currentFuel: { good: fallback, qty: fuelCapacity },
    funds: 10_000,
    location,
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "npc",
    log: [],
  };
}
