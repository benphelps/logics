import type { Trader } from "../types";

export const STARTER_TRADERS: Record<string, Trader> = {
  t_otter:    mk("t_otter",    "Otter",         60,  1, "havenport"),
  t_marlin:   mk("t_marlin",   "Marlin",        90,  1, "ironhold"),
  t_kestrel:  mk("t_kestrel",  "Kestrel",       40,  2, "greenfield"),
  t_camel:    mk("t_camel",    "Camel Caravan", 120, 1, "saffron"),
  t_swallow:  mk("t_swallow",  "Swallow",       50,  2, "havenport"),
  t_drover:   mk("t_drover",   "Drover",       100,  1, "greenfield"),
};

function mk(id: string, name: string, capacity: number, speed: number, location: string): Trader {
  return {
    id, name, capacity, speed,
    funds: 10_000,
    location,
    state: "idle",
    cargo: null,
    destination: null,
    ticksRemaining: 0,
  };
}
