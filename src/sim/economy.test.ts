import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import { consumptionDemand, productionScale, STOCKPILE_CAP_MULT } from "./economy";

describe("productionScale", () => {
  it("returns 1 below or at target stock", () => {
    expect(productionScale(50, 100)).toBe(1);
    expect(productionScale(100, 100)).toBe(1);
  });

  it("tapers linearly to 0 at the cap", () => {
    expect(productionScale(200, 100)).toBeCloseTo(0.5, 5);
    expect(productionScale(300, 100)).toBe(0);
  });

  it("clamps at 0 above the cap", () => {
    expect(productionScale(1000, 100)).toBe(0);
  });

  it("returns 1 when target is 0 (no cap modeled)", () => {
    expect(productionScale(500, 0)).toBe(1);
  });
});

describe("consumptionDemand", () => {
  it("uses full demand while stock is healthy", () => {
    expect(consumptionDemand(40, 10, 100)).toBe(10);
  });

  it("rations demand when stock is near empty", () => {
    const demand = consumptionDemand(10, 10, 100);
    expect(demand).toBeGreaterThan(0);
    expect(demand).toBeLessThan(10);
  });

  it("preserves a small local reserve instead of draining to exact zero", () => {
    expect(consumptionDemand(5, 10, 100)).toBeCloseTo(1, 5);
  });

  it("never consumes more than available stock", () => {
    expect(consumptionDemand(2, 10, 100)).toBeLessThanOrEqual(2);
  });
});

describe("Tier 1 stability", () => {
  it("producer stockpiles stay below the cap multiple of target", () => {
    const w = createWorld();
    tickN(w, 500);
    for (const loc of Object.values(w.locations)) {
      const market = w.markets[loc.id];
      for (const entry of loc.produces) {
        const target = loc.targetStock[entry.good] ?? 0;
        if (target <= 0) continue;
        const stock = market.stock[entry.good] ?? 0;
        expect(stock).toBeLessThanOrEqual(target * STOCKPILE_CAP_MULT + 0.01);
      }
    }
  });

  it("system reaches a finite steady state — total wealth bounded", () => {
    const w = createWorld();
    tickN(w, 1000);
    const totalFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    expect(totalFunds).toBeLessThan(2_000_000);
  });

  it("a broke trader freezes rather than accumulating unbounded debt", () => {
    const w = createWorld();
    const t = Object.values(w.traders)[0];
    t.funds = 0;
    t.location = "saffron";
    t.state = "idle";
    t.cargo = [];
    t.currentFuel = { good: t.fuelTypes[0].good, qty: 0 };
    tickN(w, 200);
    expect(t.funds).toBeGreaterThanOrEqual(0);
  });
});
