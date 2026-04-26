import { describe, it, expect } from "vitest";
import { generateWorld } from "./world";
import { tickN } from "../tick";
import { STOCKPILE_CAP_MULT } from "../economy";
import { mulberry32, pick } from "./rng";

describe("seeded generation", () => {
  it("same seed produces identical worlds", () => {
    const a = generateWorld({ seed: 42, locationCount: 12 });
    const b = generateWorld({ seed: 42, locationCount: 12 });
    expect(Object.keys(a.locations)).toEqual(Object.keys(b.locations));
    for (const id of Object.keys(a.locations)) {
      expect(b.locations[id].name).toBe(a.locations[id].name);
      expect(b.locations[id].position).toEqual(a.locations[id].position);
      expect(b.locations[id].traits).toEqual(a.locations[id].traits);
    }
    expect(Object.keys(a.traders)).toEqual(Object.keys(b.traders));
  });

  it("different seeds produce different worlds", () => {
    const a = generateWorld({ seed: 1, locationCount: 12 });
    const b = generateWorld({ seed: 2, locationCount: 12 });
    expect(Object.keys(a.locations)).not.toEqual(Object.keys(b.locations));
  });

  it("ticks deterministically (same seed → same final state)", () => {
    const a = generateWorld({ seed: 7, locationCount: 20 });
    const b = generateWorld({ seed: 7, locationCount: 20 });
    tickN(a, 100);
    tickN(b, 100);
    for (const id of Object.keys(a.locations)) {
      for (const goodId of Object.keys(a.goods)) {
        expect(b.markets[id].stock[goodId]).toBeCloseTo(a.markets[id].stock[goodId], 4);
        expect(b.markets[id].prices[goodId]).toBeCloseTo(a.markets[id].prices[goodId], 4);
      }
    }
  });
});

describe("generated world structure", () => {
  it("requested locationCount is honored", () => {
    for (const n of [1, 5, 20, 100]) {
      const w = generateWorld({ seed: 99, locationCount: n });
      expect(Object.keys(w.locations).length).toBe(n);
    }
  });

  it("with locationCount >= 3 always includes trade-hub, mining-belt, agricultural-ring archetypes", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = generateWorld({ seed, locationCount: 8 });
      const tags = Object.values(w.locations).flatMap(l => l.traits.tags);
      expect(tags).toContain("trade-hub");
      expect(tags).toContain("mining");
      expect(tags).toContain("agricultural");
    }
  });

  it("first location is at origin", () => {
    const w = generateWorld({ seed: 13, locationCount: 5 });
    const first = Object.values(w.locations)[0];
    expect(first.position).toEqual({ x: 0, y: 0 });
  });

  it("declared primaryExports/Imports are consistent with production data", () => {
    const w = generateWorld({ seed: 17, locationCount: 30 });
    for (const loc of Object.values(w.locations)) {
      for (const goodId of loc.primaryExports) {
        const produced = loc.produces.find(p => p.good === goodId)?.ratePerTick ?? 0;
        const consumed = loc.consumes.find(c => c.good === goodId)?.ratePerTick ?? 0;
        expect(produced - consumed).toBeGreaterThan(0);
      }
      for (const goodId of loc.primaryImports) {
        const produced = loc.produces.find(p => p.good === goodId)?.ratePerTick ?? 0;
        const consumed = loc.consumes.find(c => c.good === goodId)?.ratePerTick ?? 0;
        expect(produced - consumed).toBeLessThan(0);
      }
    }
  });

  it("generated traders start at valid locations and have valid fuel", () => {
    const w = generateWorld({ seed: 33, locationCount: 25, traderCount: 60 });
    expect(Object.keys(w.traders).length).toBe(60);
    for (const t of Object.values(w.traders)) {
      expect(w.locations[t.location]).toBeDefined();
      expect(t.fuelTypes.length).toBeGreaterThan(0);
      expect(t.currentFuel).not.toBeNull();
      const valid = t.fuelTypes.some(f => f.good === t.currentFuel!.good);
      expect(valid).toBe(true);
    }
  });

  it("antimatter-hybrid traders only spawn when antimatter is producible somewhere", () => {
    const w = generateWorld({ seed: 99, locationCount: 5 });
    const hasAntimatterProducer = Object.values(w.locations).some(loc =>
      loc.produces.some(p => p.good === "antimatter" && (p.requiresTechLevel == null || loc.traits.techLevel >= p.requiresTechLevel)),
    );
    if (!hasAntimatterProducer) {
      for (const t of Object.values(w.traders)) {
        expect(t.fuelTypes.find(f => f.good === "antimatter")).toBeUndefined();
      }
    }
  });
});

describe("invariants hold at scale", () => {
  const seeds = [1, 2, 3];
  const sizes = [20, 50];
  const heavySize = 200;

  for (const seed of seeds) {
    for (const locationCount of sizes) {
      it(`seed=${seed}, ${locationCount} locations: prices stay in clamp band`, () => {
        const w = generateWorld({ seed, locationCount });
        tickN(w, 200);
        for (const loc of Object.values(w.locations)) {
          for (const good of Object.values(w.goods)) {
            const p = w.markets[loc.id].prices[good.id];
            expect(p).toBeGreaterThanOrEqual(good.basePrice * 0.25 - 0.01);
            expect(p).toBeLessThanOrEqual(good.basePrice * 5 + 0.01);
          }
        }
      });

      it(`seed=${seed}, ${locationCount} locations: stockpiles stay below cap`, () => {
        const w = generateWorld({ seed, locationCount });
        tickN(w, 200);
        for (const loc of Object.values(w.locations)) {
          for (const entry of loc.produces) {
            const target = loc.targetStock[entry.good] ?? 0;
            if (target <= 0) continue;
            const stock = w.markets[loc.id].stock[entry.good] ?? 0;
            expect(stock).toBeLessThanOrEqual(target * STOCKPILE_CAP_MULT + 0.01);
          }
        }
      });

      it(`seed=${seed}, ${locationCount} locations: trader funds never go negative`, () => {
        const w = generateWorld({ seed, locationCount });
        tickN(w, 200);
        for (const t of Object.values(w.traders)) {
          expect(t.funds).toBeGreaterThanOrEqual(0);
        }
      });
    }
  }

  it(`heavy load: invariants hold at ${heavySize} locations (single seed, fewer ticks)`, () => {
    const w = generateWorld({ seed: 99, locationCount: heavySize });
    tickN(w, 100);
    for (const loc of Object.values(w.locations)) {
      for (const good of Object.values(w.goods)) {
        const p = w.markets[loc.id].prices[good.id];
        expect(p).toBeGreaterThanOrEqual(good.basePrice * 0.25 - 0.01);
        expect(p).toBeLessThanOrEqual(good.basePrice * 5 + 0.01);
      }
    }
    for (const t of Object.values(w.traders)) {
      expect(t.funds).toBeGreaterThanOrEqual(0);
    }
  });
});
