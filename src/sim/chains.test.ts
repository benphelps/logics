import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import type { LocationDef } from "./types";

describe("tech-gated production", () => {
  it("a recipe with requiresTechLevel only fires when location meets it", () => {
    const baseLoc = (techLevel: number): LocationDef => ({
      id: "lab",
      name: "Lab",
      position: { x: 0, y: 0 },
      population: 100,
      traits: { techLevel, tags: [] },
      primaryExports: ["electronics"],
      primaryImports: [],
      produces: [
        { good: "electronics", ratePerTick: 5, requiresTechLevel: 7,
          inputs: [{ good: "parts", perUnit: 0.5 }, { good: "antimatter", perUnit: 0.2 }] },
      ],
      consumes: [],
      targetStock: { electronics: 100, parts: 100, antimatter: 100 },
    });

    const lowTech = createWorld({ locations: { lab: baseLoc(5) }, lanes: {}, traders: {} });
    const highTech = createWorld({ locations: { lab: baseLoc(8) }, lanes: {}, traders: {} });

    lowTech.markets.lab.stock.parts = 100;
    lowTech.markets.lab.stock.antimatter = 100;
    lowTech.markets.lab.stock.electronics = 0;
    highTech.markets.lab.stock.parts = 100;
    highTech.markets.lab.stock.antimatter = 100;
    highTech.markets.lab.stock.electronics = 0;

    tickWorld(lowTech);
    tickWorld(highTech);

    expect(lowTech.markets.lab.stock.electronics).toBe(0);
    expect(highTech.markets.lab.stock.electronics).toBeGreaterThan(0);
  });

  it("starter universe: ironhold produces electronics, verdant cannot", () => {
    const noTraders = createWorld({ traders: {} });
    tickN(noTraders, 50);
    expect(noTraders.markets.ironhold.stock.electronics).toBeGreaterThan(0);
    const verdantTarget = noTraders.locations.verdant.targetStock.electronics ?? 0;
    expect(noTraders.markets.verdant.stock.electronics).toBeLessThan(verdantTarget * 0.15);
  });

  it("starter universe: saffron produces luxury_goods (tech 5 = recipe req 5)", () => {
    const w = createWorld({ traders: {} });
    tickN(w, 50);
    expect(w.markets.saffron.stock.luxury_goods).toBeGreaterThan(0);
  });
});

describe("multi-tier chain throttling", () => {
  it("when tier-1 input is starved, tier-2 production drops", () => {
    const w = createWorld({ traders: {} });
    tickN(w, 100);

    const beforeElectronics = w.markets.ironhold.stock.electronics;

    w.markets.ironhold.stock.parts = 0;
    w.markets.ironhold.stock.ore = 0;
    const oreEntry = w.locations.ironhold.produces.find(p => p.good === "ore")!;
    const partsEntry = w.locations.ironhold.produces.find(p => p.good === "parts")!;
    oreEntry.ratePerTick = 0;
    partsEntry.ratePerTick = 0;

    tickN(w, 30);
    const afterElectronics = w.markets.ironhold.stock.electronics;
    expect(afterElectronics).toBeLessThanOrEqual(beforeElectronics);
  });

  it("luxury_goods at saffron throttles when fiber import is cut", () => {
    const w = createWorld({ traders: {} });
    tickN(w, 100);

    const luxuryEntry = w.locations.saffron.produces.find(p => p.good === "luxury_goods")!;
    expect(luxuryEntry).toBeDefined();

    w.markets.saffron.stock.fiber = 0;
    const before = w.markets.saffron.stock.luxury_goods;
    tickN(w, 5);
    const after = w.markets.saffron.stock.luxury_goods;
    expect(after - before).toBeLessThanOrEqual(0.001);
  });
});

describe("tier-2 economy reaches finite steady state", () => {
  const goodsToCheck = ["electronics", "weapons", "luxury_goods", "medkits"] as const;

  it("every tier-2 good has bounded prices at every location", () => {
    const w = createWorld();
    tickN(w, 500);
    for (const loc of Object.values(w.locations)) {
      for (const good of goodsToCheck) {
        const price = w.markets[loc.id].prices[good];
        const base = w.goods[good].basePrice;
        expect(price).toBeGreaterThanOrEqual(base * 0.25 - 0.01);
        expect(price).toBeLessThanOrEqual(base * 5 + 0.01);
      }
    }
  });

  it("no tier-2 good is permanently starved everywhere — at least one location holds stock", () => {
    const w = createWorld();
    tickN(w, 300);
    for (const good of goodsToCheck) {
      const totalStock = Object.values(w.markets).reduce((s, m) => s + m.stock[good], 0);
      expect(totalStock).toBeGreaterThan(0);
    }
  });
});
