import type { LocationDef, Position } from "../types";
import { type ArchetypeName } from "./names";
import { jitter, rangeInt, type Rng } from "./rng";

export type { ArchetypeName };

export const ARCHETYPE_NAMES: ArchetypeName[] = [
  "trade-hub",
  "mining-belt",
  "agricultural-ring",
  "frontier-outpost",
  "research-station",
];

interface ArchetypeBuildContext {
  rng: Rng;
  id: string;
  name: string;
  position: Position;
}

type Builder = (ctx: ArchetypeBuildContext) => LocationDef;

const tradeHub: Builder = ({ rng, id, name, position }) => {
  const techLevel = rangeInt(rng, 5, 7);
  return {
    id, name, position,
    population: rangeInt(rng, 800, 1500),
    traits: {
      techLevel,
      tags: ["trade-hub", "core", "civilian"],
      faction: "League",
    },
    primaryExports: ["protein", "fiber", "medkits"],
    primaryImports: ["grain", "polymer", "parts", "electronics", "luxury_goods", "weapons"],
    produces: [
      { good: "protein", ratePerTick: jitter(rng, 14, 0.2) },
      { good: "fiber",   ratePerTick: jitter(rng, 4, 0.2), inputs: [{ good: "polymer", perUnit: 0.2 }] },
      { good: "medkits", ratePerTick: jitter(rng, 3, 0.2), requiresTechLevel: 4,
        inputs: [{ good: "protein", perUnit: 0.5 }, { good: "fiber", perUnit: 0.3 }] },
    ],
    consumes: [
      { good: "grain",        ratePerTick: jitter(rng, 8, 0.15) },
      { good: "polymer",      ratePerTick: jitter(rng, 2, 0.15) },
      { good: "parts",        ratePerTick: jitter(rng, 1, 0.15) },
      { good: "plasma",       ratePerTick: jitter(rng, 3, 0.15) },
      { good: "electronics",  ratePerTick: jitter(rng, 0.5, 0.2) },
      { good: "weapons",      ratePerTick: jitter(rng, 0.3, 0.2) },
      { good: "luxury_goods", ratePerTick: jitter(rng, 0.5, 0.2) },
    ],
    targetStock: {
      protein: 100, grain: 80, polymer: 40, fiber: 40, parts: 20, plasma: 30,
      medkits: 40, electronics: 20, weapons: 15, luxury_goods: 20,
    },
  };
};

const miningBelt: Builder = ({ rng, id, name, position }) => {
  const techLevel = rangeInt(rng, 6, 8);
  const produces: LocationDef["produces"] = [
    { good: "ore",    ratePerTick: jitter(rng, 12, 0.2) },
    { good: "parts",  ratePerTick: jitter(rng, 5, 0.2),  inputs: [{ good: "ore", perUnit: 1.5 }] },
    { good: "plasma", ratePerTick: jitter(rng, 14, 0.2) },
  ];
  const exports: string[] = ["ore", "parts", "plasma"];
  if (techLevel >= 7) {
    produces.push({
      good: "antimatter", ratePerTick: jitter(rng, 3, 0.3), requiresTechLevel: 7,
      inputs: [{ good: "plasma", perUnit: 0.8 }],
    });
    exports.push("antimatter");
  }
  if (techLevel >= 6) {
    produces.push({
      good: "weapons", ratePerTick: jitter(rng, 2, 0.3), requiresTechLevel: 6,
      inputs: [{ good: "parts", perUnit: 0.6 }, { good: "polymer", perUnit: 0.3 }],
    });
    exports.push("weapons");
  }
  return {
    id, name, position,
    population: rangeInt(rng, 500, 1000),
    traits: {
      techLevel,
      tags: ["industrial", "core", "mining"],
      faction: "League",
    },
    primaryExports: exports,
    primaryImports: ["grain", "protein", "polymer", "medkits"],
    produces,
    consumes: [
      { good: "grain",   ratePerTick: jitter(rng, 6, 0.15) },
      { good: "protein", ratePerTick: jitter(rng, 2, 0.15) },
      { good: "polymer", ratePerTick: jitter(rng, 4, 0.15) },
      { good: "plasma",  ratePerTick: jitter(rng, 4, 0.15) },
      { good: "medkits", ratePerTick: jitter(rng, 0.5, 0.2) },
    ],
    targetStock: {
      ore: 120, parts: 30, grain: 60, protein: 20, polymer: 30, plasma: 30, antimatter: 40,
      weapons: 30, medkits: 10,
    },
  };
};

const agriculturalRing: Builder = ({ rng, id, name, position }) => {
  const techLevel = rangeInt(rng, 3, 5);
  return {
    id, name, position,
    population: rangeInt(rng, 1000, 2000),
    traits: {
      techLevel,
      tags: ["agricultural", "ring-habitat", "core"],
      faction: "League",
    },
    primaryExports: ["grain", "vatmeat", "polymer"],
    primaryImports: ["parts", "fiber", "medkits", "electronics"],
    produces: [
      { good: "grain",   ratePerTick: jitter(rng, 22, 0.2) },
      { good: "vatmeat", ratePerTick: jitter(rng, 5, 0.2) },
      { good: "polymer", ratePerTick: jitter(rng, 9, 0.2) },
    ],
    consumes: [
      { good: "parts",       ratePerTick: jitter(rng, 2, 0.15) },
      { good: "fiber",       ratePerTick: jitter(rng, 2, 0.15) },
      { good: "plasma",      ratePerTick: jitter(rng, 3, 0.15) },
      { good: "medkits",     ratePerTick: jitter(rng, 1.0, 0.2) },
      { good: "electronics", ratePerTick: jitter(rng, 0.4, 0.2) },
      { good: "weapons",     ratePerTick: jitter(rng, 0.2, 0.2) },
    ],
    targetStock: {
      grain: 200, vatmeat: 50, polymer: 80, parts: 20, fiber: 20, plasma: 30,
      medkits: 50, electronics: 20, weapons: 10,
    },
  };
};

const frontierOutpost: Builder = ({ rng, id, name, position }) => {
  const techLevel = rangeInt(rng, 4, 6);
  const luxuryGood = rng() < 0.5 ? "xenospice" : "silk";
  const otherLuxury = luxuryGood === "xenospice" ? "silk" : "xenospice";
  const produces: LocationDef["produces"] = [
    { good: luxuryGood, ratePerTick: jitter(rng, 4, 0.3) },
  ];
  if (rng() < 0.4) {
    produces.push({ good: otherLuxury, ratePerTick: jitter(rng, 2, 0.3) });
  }
  const exports: string[] = [luxuryGood];
  if (techLevel >= 5 && produces.some(p => p.good === "silk") && produces.some(p => p.good === "xenospice")) {
    produces.push({
      good: "luxury_goods", ratePerTick: jitter(rng, 2, 0.3), requiresTechLevel: 5,
      inputs: [{ good: "silk", perUnit: 0.3 }, { good: "xenospice", perUnit: 0.4 }, { good: "fiber", perUnit: 0.5 }],
    });
    exports.push("luxury_goods");
  }
  return {
    id, name, position,
    population: rangeInt(rng, 300, 700),
    traits: {
      techLevel,
      tags: ["frontier", "rim", "luxury"],
      faction: "Outerguild",
    },
    primaryExports: exports,
    primaryImports: ["grain", "protein", "parts", "medkits", "weapons"],
    produces,
    consumes: [
      { good: "grain",       ratePerTick: jitter(rng, 5, 0.2) },
      { good: "protein",     ratePerTick: jitter(rng, 3, 0.2) },
      { good: "parts",       ratePerTick: jitter(rng, 1, 0.2) },
      { good: "plasma",      ratePerTick: jitter(rng, 2, 0.2) },
      { good: "medkits",     ratePerTick: jitter(rng, 0.4, 0.2) },
      { good: "electronics", ratePerTick: jitter(rng, 0.3, 0.2) },
      { good: "weapons",     ratePerTick: jitter(rng, 0.5, 0.2) },
    ],
    targetStock: {
      xenospice: 30, silk: 20, grain: 40, protein: 25, parts: 10, plasma: 20,
      luxury_goods: 30, medkits: 15, electronics: 15, weapons: 20, fiber: 10,
    },
  };
};

const researchStation: Builder = ({ rng, id, name, position }) => {
  const techLevel = rangeInt(rng, 7, 10);
  return {
    id, name, position,
    population: rangeInt(rng, 200, 500),
    traits: {
      techLevel,
      tags: ["research", "high-tech"],
      faction: "League",
    },
    primaryExports: ["electronics"],
    primaryImports: ["grain", "protein", "parts", "antimatter", "medkits", "luxury_goods"],
    produces: [
      { good: "electronics", ratePerTick: jitter(rng, 2.5, 0.3), requiresTechLevel: 7,
        inputs: [{ good: "parts", perUnit: 0.5 }, { good: "antimatter", perUnit: 0.2 }] },
    ],
    consumes: [
      { good: "grain",        ratePerTick: jitter(rng, 3, 0.2) },
      { good: "protein",      ratePerTick: jitter(rng, 2, 0.2) },
      { good: "parts",        ratePerTick: jitter(rng, 2, 0.2) },
      { good: "antimatter",   ratePerTick: jitter(rng, 1, 0.2) },
      { good: "plasma",       ratePerTick: jitter(rng, 2, 0.2) },
      { good: "medkits",      ratePerTick: jitter(rng, 0.5, 0.2) },
      { good: "luxury_goods", ratePerTick: jitter(rng, 0.3, 0.2) },
    ],
    targetStock: {
      electronics: 40, grain: 30, protein: 20, parts: 30, antimatter: 25, plasma: 20,
      medkits: 15, luxury_goods: 10,
    },
  };
};

export const ARCHETYPE_BUILDERS: Record<ArchetypeName, Builder> = {
  "trade-hub":          tradeHub,
  "mining-belt":        miningBelt,
  "agricultural-ring":  agriculturalRing,
  "frontier-outpost":   frontierOutpost,
  "research-station":   researchStation,
};
