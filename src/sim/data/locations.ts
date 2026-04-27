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
    primaryExports: ["protein", "fiber", "medkits"],
    primaryImports: ["grain", "polymer", "parts", "electronics", "luxury_goods", "weapons"],
    produces: [
      { good: "protein", ratePerTick: 14 },
      { good: "fiber",   ratePerTick: 4, inputs: [{ good: "polymer", perUnit: 0.2 }] },
      { good: "medkits", ratePerTick: 3, requiresTechLevel: 4,
        inputs: [{ good: "protein", perUnit: 0.5 }, { good: "fiber", perUnit: 0.3 }] },
    ],
    consumes: [
      { good: "grain",        ratePerTick: 8 },
      { good: "polymer",      ratePerTick: 2 },
      { good: "parts",        ratePerTick: 1 },
      { good: "plasma",       ratePerTick: 3 },
      { good: "electronics",  ratePerTick: 0.5 },
      { good: "weapons",      ratePerTick: 0.3 },
      { good: "luxury_goods", ratePerTick: 0.5 },
    ],
    targetStock: {
      protein: 100, grain: 80, polymer: 40, fiber: 40, parts: 20, plasma: 30,
      medkits: 40, electronics: 20, weapons: 15, luxury_goods: 20,
      upg_cargo_1: 1, upg_fuel_1: 1, upg_hull_1: 1,
    },
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
    primaryExports: ["ore", "parts", "plasma", "antimatter", "electronics", "weapons"],
    primaryImports: ["grain", "protein", "polymer", "medkits"],
    produces: [
      { good: "ore",        ratePerTick: 12 },
      { good: "parts",      ratePerTick: 5, inputs: [{ good: "ore", perUnit: 1.5 }] },
      { good: "plasma",     ratePerTick: 14 },
      { good: "antimatter", ratePerTick: 3, inputs: [{ good: "plasma", perUnit: 0.8 }] },
      { good: "electronics", ratePerTick: 2, requiresTechLevel: 7,
        inputs: [{ good: "parts", perUnit: 0.5 }, { good: "antimatter", perUnit: 0.2 }] },
      { good: "weapons", ratePerTick: 2, requiresTechLevel: 6,
        inputs: [{ good: "parts", perUnit: 0.6 }, { good: "polymer", perUnit: 0.3 }] },
    ],
    consumes: [
      { good: "grain",   ratePerTick: 6 },
      { good: "protein", ratePerTick: 2 },
      { good: "polymer", ratePerTick: 4 },
      { good: "plasma",  ratePerTick: 4 },
      { good: "medkits", ratePerTick: 0.5 },
    ],
    targetStock: {
      ore: 120, parts: 30, grain: 60, protein: 20, polymer: 30, plasma: 30, antimatter: 40,
      electronics: 30, weapons: 30, medkits: 10,
      upg_engine_1: 1, upg_fuel_1: 1, upg_hull_1: 1, upg_weapon_1: 1,
      upg_engine_2: 1, upg_hull_2: 1, upg_weapon_2: 1, upg_engine_3: 1,
    },
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
    primaryImports: ["parts", "fiber", "medkits", "electronics", "weapons"],
    produces: [
      { good: "grain",   ratePerTick: 22 },
      { good: "vatmeat", ratePerTick: 5 },
      { good: "polymer", ratePerTick: 9 },
    ],
    consumes: [
      { good: "parts",       ratePerTick: 2 },
      { good: "fiber",       ratePerTick: 2 },
      { good: "plasma",      ratePerTick: 3 },
      { good: "medkits",     ratePerTick: 1.0 },
      { good: "electronics", ratePerTick: 0.4 },
      { good: "weapons",     ratePerTick: 0.2 },
    ],
    targetStock: {
      grain: 200, vatmeat: 50, polymer: 80, parts: 20, fiber: 20, plasma: 30,
      medkits: 50, electronics: 20, weapons: 10,
      upg_cargo_1: 1, upg_fuel_1: 1,
    },
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
    primaryExports: ["xenospice", "silk", "luxury_goods"],
    primaryImports: ["grain", "protein", "parts", "medkits", "electronics", "weapons"],
    produces: [
      { good: "xenospice", ratePerTick: 4 },
      { good: "silk",      ratePerTick: 2 },
      { good: "luxury_goods", ratePerTick: 2, requiresTechLevel: 5,
        inputs: [{ good: "silk", perUnit: 0.3 }, { good: "xenospice", perUnit: 0.4 }, { good: "fiber", perUnit: 0.5 }] },
    ],
    consumes: [
      { good: "grain",       ratePerTick: 5 },
      { good: "protein",     ratePerTick: 3 },
      { good: "parts",       ratePerTick: 1 },
      { good: "plasma",      ratePerTick: 2 },
      { good: "medkits",     ratePerTick: 0.4 },
      { good: "electronics", ratePerTick: 0.3 },
      { good: "weapons",     ratePerTick: 0.5 },
    ],
    targetStock: {
      xenospice: 30, silk: 20, grain: 40, protein: 25, parts: 10, plasma: 20,
      luxury_goods: 30, medkits: 15, electronics: 15, weapons: 20,
      upg_cargo_2: 1, upg_fuel_2: 1, upg_hull_2: 1, upg_weapon_2: 1,
      upg_cargo_3: 1, upg_fuel_3: 1, upg_hull_3: 1, upg_weapon_3: 1,
    },
  },
};

export const LANES: LaneMap = {};
