import type { LaneMap, LocationDef } from "../types";

export const LOCATIONS: Record<string, LocationDef> = {
  haven: {
    id: "haven",
    name: "Haven Station",
    position: { x: 0, y: 0 },
    population: 1200,
    traits: {
      techLevel: 6,
      tags: ["trade-hub", "core", "civilian"],
      faction: "League",
    },
    primaryExports: ["protein", "fiber"],
    primaryImports: ["grain", "polymer", "parts"],
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
    position: { x: 4, y: 0 },
    population: 800,
    traits: {
      techLevel: 8,
      tags: ["industrial", "core", "mining"],
      faction: "League",
    },
    primaryExports: ["ore", "parts", "plasma", "antimatter"],
    primaryImports: ["grain", "protein", "polymer"],
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
    position: { x: 1, y: 3 },
    population: 1500,
    traits: {
      techLevel: 4,
      tags: ["agricultural", "ring-habitat", "core"],
      faction: "League",
    },
    primaryExports: ["grain", "vatmeat", "polymer"],
    primaryImports: ["parts", "fiber"],
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
    position: { x: 8, y: 8 },
    population: 600,
    traits: {
      techLevel: 5,
      tags: ["frontier", "rim", "luxury"],
      faction: "Outerguild",
    },
    primaryExports: ["xenospice", "silk"],
    primaryImports: ["grain", "protein", "parts"],
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

export const LANES: LaneMap = {};
