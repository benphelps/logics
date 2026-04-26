import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickWorld, tickN } from "./tick";

describe("tick loop", () => {
  it("increments tick counter", () => {
    const w = createWorld();
    expect(w.tick).toBe(0);
    tickWorld(w);
    expect(w.tick).toBe(1);
    tickN(w, 9);
    expect(w.tick).toBe(10);
  });

  it("is deterministic — same seed world produces same final state", () => {
    const a = createWorld();
    const b = createWorld();
    tickN(a, 50);
    tickN(b, 50);
    for (const locId of Object.keys(a.locations)) {
      for (const goodId of Object.keys(a.goods)) {
        expect(b.markets[locId].stock[goodId]).toBeCloseTo(a.markets[locId].stock[goodId], 5);
        expect(b.markets[locId].prices[goodId]).toBeCloseTo(a.markets[locId].prices[goodId], 5);
      }
    }
  });

  it("never lets stock go negative", () => {
    const w = createWorld();
    tickN(w, 100);
    for (const market of Object.values(w.markets)) {
      for (const qty of Object.values(market.stock)) {
        expect(qty).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("production with inputs is gated by input availability", () => {
    const w = createWorld({
      locations: {
        forge: {
          id: "forge",
          name: "Forge",
          population: 100,
          produces: [{ good: "tools", ratePerTick: 5, inputs: [{ good: "ore", perUnit: 1.5 }] }],
          consumes: [],
          targetStock: { tools: 50, ore: 50 },
        },
      },
      distances: { forge: { forge: 0 } },
      traders: {},
    });
    w.markets.forge.stock.ore = 0;
    w.markets.forge.stock.tools = 10;
    tickWorld(w);
    expect(w.markets.forge.stock.tools).toBeCloseTo(10, 5);
  });
});
