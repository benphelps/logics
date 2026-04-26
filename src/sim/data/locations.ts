import type { LocationDef } from "../types";

export const LOCATIONS: Record<string, LocationDef> = {
  havenport: {
    id: "havenport",
    name: "Havenport",
    population: 1200,
    produces: [
      { good: "fish",  ratePerTick: 14 },
      { good: "cloth", ratePerTick: 4, inputs: [{ good: "wood", perUnit: 0.2 }] },
    ],
    consumes: [
      { good: "grain", ratePerTick: 8 },
      { good: "wood",  ratePerTick: 2 },
      { good: "tools", ratePerTick: 1 },
      { good: "fuel",  ratePerTick: 3 },
    ],
    targetStock: { fish: 100, grain: 80, wood: 40, cloth: 40, tools: 20, fuel: 30 },
  },

  ironhold: {
    id: "ironhold",
    name: "Ironhold",
    population: 800,
    produces: [
      { good: "ore",   ratePerTick: 12 },
      { good: "tools", ratePerTick: 3, inputs: [{ good: "ore", perUnit: 1.5 }] },
    ],
    consumes: [
      { good: "grain", ratePerTick: 6 },
      { good: "fish",  ratePerTick: 2 },
      { good: "wood",  ratePerTick: 4 },
      { good: "fuel",  ratePerTick: 4 },
    ],
    targetStock: { ore: 120, tools: 30, grain: 60, fish: 20, wood: 30, fuel: 30 },
  },

  greenfield: {
    id: "greenfield",
    name: "Greenfield",
    population: 1500,
    produces: [
      { good: "grain", ratePerTick: 22 },
      { good: "meat",  ratePerTick: 5 },
      { good: "wood",  ratePerTick: 9 },
    ],
    consumes: [
      { good: "tools", ratePerTick: 2 },
      { good: "cloth", ratePerTick: 2 },
      { good: "fuel",  ratePerTick: 3 },
    ],
    targetStock: { grain: 200, meat: 50, wood: 80, tools: 20, cloth: 20, fuel: 30 },
  },

  saffron: {
    id: "saffron",
    name: "Saffron Reach",
    population: 600,
    produces: [
      { good: "spice", ratePerTick: 4 },
      { good: "silk",  ratePerTick: 2 },
    ],
    consumes: [
      { good: "grain", ratePerTick: 5 },
      { good: "fish",  ratePerTick: 3 },
      { good: "tools", ratePerTick: 1 },
      { good: "fuel",  ratePerTick: 2 },
    ],
    targetStock: { spice: 30, silk: 20, grain: 40, fish: 25, tools: 10, fuel: 20 },
  },
};

export const DISTANCES: Record<string, Record<string, number>> = {
  havenport:  { havenport: 0, ironhold: 5, greenfield: 3, saffron: 8 },
  ironhold:   { havenport: 5, ironhold: 0, greenfield: 4, saffron: 9 },
  greenfield: { havenport: 3, ironhold: 4, greenfield: 0, saffron: 7 },
  saffron:    { havenport: 8, ironhold: 9, greenfield: 7, saffron: 0 },
};
