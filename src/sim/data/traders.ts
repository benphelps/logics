import type { Trader } from "../types";

export const STARTER_TRADERS: Record<string, Trader> = {
  t_otter:    mk("t_otter",    "Otter",          60, 1, 30, 1.0, "havenport"),
  t_marlin:   mk("t_marlin",   "Marlin",         90, 1, 40, 1.2, "ironhold"),
  t_kestrel:  mk("t_kestrel",  "Kestrel",        40, 2, 25, 0.9, "greenfield"),
  t_camel:    mk("t_camel",    "Camel Caravan", 120, 1, 60, 1.4, "saffron"),
  t_swallow:  mk("t_swallow",  "Swallow",        50, 2, 30, 0.8, "havenport"),
  t_drover:   mk("t_drover",   "Drover",        100, 1, 50, 1.3, "greenfield"),
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
