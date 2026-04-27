import type { FuelType, GoodId, LocationDef, LocationId, Trader } from "../types";
import { generateShipName } from "./names";
import { jitter, pick, rangeInt, type Rng } from "./rng";

type ShipClass = "basic_hauler" | "fast_scout" | "antimatter_hybrid";

interface ClassSpec {
  capacityRange: [number, number];
  speedRange: [number, number];
  fuelCapRange: [number, number];
  fuel: (rng: Rng) => FuelType[];
}

const PLASMA_ONLY = (rng: Rng): FuelType[] => [
  { good: "plasma", perDistance: jitter(rng, 1.0, 0.2) },
];

const SCOUT_PLASMA = (rng: Rng): FuelType[] => [
  { good: "plasma", perDistance: jitter(rng, 0.85, 0.15) },
];

const ANTIMATTER_HYBRID = (rng: Rng): FuelType[] => [
  { good: "antimatter", perDistance: jitter(rng, 0.35, 0.2) },
  { good: "plasma",     perDistance: jitter(rng, 0.9, 0.2) },
];

const CLASS_SPECS: Record<ShipClass, ClassSpec> = {
  basic_hauler:      { capacityRange: [60, 110], speedRange: [1, 1], fuelCapRange: [30, 55], fuel: PLASMA_ONLY },
  fast_scout:        { capacityRange: [30, 55],  speedRange: [2, 2], fuelCapRange: [20, 35], fuel: SCOUT_PLASMA },
  antimatter_hybrid: { capacityRange: [50, 130], speedRange: [1, 2], fuelCapRange: [30, 70], fuel: ANTIMATTER_HYBRID },
};

interface TraderGenOptions {
  rng: Rng;
  count: number;
  locations: Record<LocationId, LocationDef>;
  antimatterAvailable: boolean;
}

export function generateTraders(opts: TraderGenOptions): Record<string, Trader> {
  const { rng, count, locations, antimatterAvailable } = opts;
  const locationIds = Object.keys(locations);
  const usedIds = new Set<string>();
  const traders: Record<string, Trader> = {};

  for (let i = 0; i < count; i++) {
    const r = rng();
    let cls: ShipClass;
    if (antimatterAvailable && r < 0.15) cls = "antimatter_hybrid";
    else if (r < 0.40) cls = "fast_scout";
    else cls = "basic_hauler";

    const spec = CLASS_SPECS[cls];
    const capacity = rangeInt(rng, spec.capacityRange[0], spec.capacityRange[1]);
    const speed = rangeInt(rng, spec.speedRange[0], spec.speedRange[1]);
    const fuelCapacity = rangeInt(rng, spec.fuelCapRange[0], spec.fuelCapRange[1]);
    const fuelTypes = spec.fuel(rng);
    const fallback = fuelTypes[fuelTypes.length - 1].good as GoodId;

    const { name, id } = generateShipName(rng, usedIds);
    const startLoc = pick(rng, locationIds);
    traders[id] = {
      id, name, capacity, speed,
      fuelCapacity, fuelTypes,
      currentFuel: { good: fallback, qty: fuelCapacity },
      funds: rangeInt(rng, 8000, 14000),
      location: startLoc,
      state: "idle",
      cargo: [],
      destination: null,
      ticksRemaining: 0,
      pilot: "npc",
    };
  }

  return traders;
}

export function locationsHaveAntimatter(locations: Record<LocationId, LocationDef>): boolean {
  for (const loc of Object.values(locations)) {
    for (const p of loc.produces) {
      if (p.good === "antimatter") {
        const gateMet = p.requiresTechLevel == null || loc.traits.techLevel >= p.requiresTechLevel;
        if (gateMet) return true;
      }
    }
  }
  return false;
}

export function _spec(_cls: ShipClass) {
  return CLASS_SPECS[_cls];
}
