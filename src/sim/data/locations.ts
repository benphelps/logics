import type { LocationDef } from "../types";

export const LOCATIONS: Record<string, LocationDef> = {
  haven: {
    id: "haven",
    name: "Haven Station",
    population: 1200,
    produces: [
      { good: "protein", ratePerTick: 14 },
      { good: "fiber",   ratePerTick: 4, inputs: [{ good: "polymer", perUnit: 0.2 }] },
    ],
    consumes: [
      { good: "grain",   ratePerTick: 8 },
      { good: "polymer", ratePerTick: 2 },
      { good: "parts",   ratePerTick: 1 },
      { good: "plasma",  ratePerTick: 3 },
    ],
    targetStock: { protein: 100, grain: 80, polymer: 40, fiber: 40, parts: 20, plasma: 30 },
  },

  ironhold: {
    id: "ironhold",
    name: "Ironhold Belt",
    population: 800,
    produces: [
      { good: "ore",        ratePerTick: 12 },
      { good: "parts",      ratePerTick: 3, inputs: [{ good: "ore", perUnit: 1.5 }] },
      { good: "plasma",     ratePerTick: 14 },
      { good: "antimatter", ratePerTick: 3, inputs: [{ good: "plasma", perUnit: 0.8 }] },
    ],
    consumes: [
      { good: "grain",   ratePerTick: 6 },
      { good: "protein", ratePerTick: 2 },
      { good: "polymer", ratePerTick: 4 },
      { good: "plasma",  ratePerTick: 4 },
    ],
    targetStock: { ore: 120, parts: 30, grain: 60, protein: 20, polymer: 30, plasma: 30, antimatter: 40 },
  },

  verdant: {
    id: "verdant",
    name: "Verdant Ring",
    population: 1500,
    produces: [
      { good: "grain",   ratePerTick: 22 },
      { good: "vatmeat", ratePerTick: 5 },
      { good: "polymer", ratePerTick: 9 },
    ],
    consumes: [
      { good: "parts",  ratePerTick: 2 },
      { good: "fiber",  ratePerTick: 2 },
      { good: "plasma", ratePerTick: 3 },
    ],
    targetStock: { grain: 200, vatmeat: 50, polymer: 80, parts: 20, fiber: 20, plasma: 30 },
  },

  saffron: {
    id: "saffron",
    name: "Saffron Rim",
    population: 600,
    produces: [
      { good: "xenospice", ratePerTick: 4 },
      { good: "silk",      ratePerTick: 2 },
    ],
    consumes: [
      { good: "grain",   ratePerTick: 5 },
      { good: "protein", ratePerTick: 3 },
      { good: "parts",   ratePerTick: 1 },
      { good: "plasma",  ratePerTick: 2 },
    ],
    targetStock: { xenospice: 30, silk: 20, grain: 40, protein: 25, parts: 10, plasma: 20 },
  },
};

export const DISTANCES: Record<string, Record<string, number>> = {
  haven:    { haven: 0, ironhold: 5, verdant: 3, saffron: 8 },
  ironhold: { haven: 5, ironhold: 0, verdant: 4, saffron: 9 },
  verdant:  { haven: 3, ironhold: 4, verdant: 0, saffron: 7 },
  saffron:  { haven: 8, ironhold: 9, verdant: 7, saffron: 0 },
};
