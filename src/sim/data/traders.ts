import type { Trader } from "../types";

export const STARTER_TRADERS: Record<string, Trader> = {
  t_pelican:   mk("t_pelican",   "Pelican",    60, 1, 30, 1.0, "haven"),
  t_mantis:    mk("t_mantis",    "Mantis",     90, 1, 40, 1.2, "ironhold"),
  t_kestrel:   mk("t_kestrel",   "Kestrel",    40, 2, 25, 0.9, "verdant"),
  t_leviathan: mk("t_leviathan", "Leviathan", 120, 1, 60, 1.4, "saffron"),
  t_falcon:    mk("t_falcon",    "Falcon",     50, 2, 30, 0.8, "haven"),
  t_mule:      mk("t_mule",      "Mule",      100, 1, 50, 1.3, "verdant"),
};

function mk(
  id: string,
  name: string,
  capacity: number,
  speed: number,
  fuelCapacity: number,
  fuelPerDistance: number,
  location: string,
): Trader {
  return {
    id, name, capacity, speed,
    fuelCapacity,
    fuelPerDistance,
    fuelTank: fuelCapacity,
    funds: 10_000,
    location,
    state: "idle",
    cargo: null,
    destination: null,
    ticksRemaining: 0,
  };
}
