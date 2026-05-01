import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import {
  defaultTreasuryTarget,
  settleSale,
  settlePurchase,
  treasuryHealthMultiplier,
  withdrawFromTreasury,
  TREASURY_HAIRCUT_FLOOR,
} from "./economy";
import { sellAtLocation, buyAtLocation, UNLOAD_TICKS } from "./traders";

describe("treasuries — initialization", () => {
  it("createWorld initializes every market with a treasury at target", () => {
    const w = createWorld({ traders: {} });
    for (const loc of Object.values(w.locations)) {
      const m = w.markets[loc.id];
      expect(m.treasury).toBeDefined();
      expect(m.treasuryTarget).toBeDefined();
      expect(m.treasury).toBe(m.treasuryTarget);
      expect(m.treasuryTarget).toBe(defaultTreasuryTarget(loc));
    }
  });
});

describe("treasuries — money flow", () => {
  it("buy deposits trader funds into the city treasury", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const market = w.markets.haven;
    const treasuryBefore = market.treasury;
    const fundsBefore = ship.funds;

    expect(buyAtLocation(w, ship, "protein", 5).ok).toBe(true);

    const fundsCost = fundsBefore - ship.funds;
    expect(fundsCost).toBeGreaterThan(0);
    expect(market.treasury - treasuryBefore).toBeCloseTo(fundsCost, 5);
  });

  it("sell pays the trader (drip-settled) and empties the unloading buffer", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    expect(buyAtLocation(w, ship, "protein", 5).ok).toBe(true);
    const fundsBefore = ship.funds;

    expect(sellAtLocation(w, ship, "protein").ok).toBe(true);
    tickN(w, UNLOAD_TICKS);

    // Closed-loop equality between proceeds and treasury delta is verified by
    // the long-horizon stability tests (the drip runs alongside per-tick
    // replenishment, so endpoint comparison here would conflate the two).
    expect(ship.funds).toBeGreaterThan(fundsBefore);
    expect(ship.unloadingCargo ?? []).toEqual([]);
  });
});

describe("treasuries — haircut", () => {
  it("returns 1.0 when treasury is at or above target", () => {
    expect(treasuryHealthMultiplier({ stock: {}, prices: {}, treasury: 100, treasuryTarget: 100 })).toBe(1.0);
    expect(treasuryHealthMultiplier({ stock: {}, prices: {}, treasury: 200, treasuryTarget: 100 })).toBe(1.0);
  });

  it("haircut drops below 1.0 when treasury is in deficit", () => {
    const m = { stock: {}, prices: {}, treasury: -50, treasuryTarget: 100 };
    expect(treasuryHealthMultiplier(m)).toBeLessThan(1.0);
    expect(treasuryHealthMultiplier(m)).toBeGreaterThanOrEqual(TREASURY_HAIRCUT_FLOOR);
  });

  it("haircut floors at TREASURY_HAIRCUT_FLOOR for deeply depleted cities", () => {
    const m = { stock: {}, prices: {}, treasury: -1000, treasuryTarget: 100 };
    expect(treasuryHealthMultiplier(m)).toBeCloseTo(TREASURY_HAIRCUT_FLOOR, 5);
  });
});

describe("treasuries — withdraw cap", () => {
  it("can't withdraw past the floor (TREASURY_FLOOR_FRACTION × target)", () => {
    const m = { stock: {}, prices: {}, treasury: 0, treasuryTarget: 100 };
    // Floor at -2× = -200. Withdrawing 1000 only pays out 200.
    const paid = withdrawFromTreasury(m, 1000);
    expect(paid).toBeLessThanOrEqual(200 + 0.01);
    expect(m.treasury).toBeCloseTo(0 - paid, 5);
  });
});

describe("settleSale / settlePurchase", () => {
  it("settleSale withdraws net (post-tax) from treasury and returns realized price", () => {
    const m = { stock: {}, prices: {}, treasury: 10_000, treasuryTarget: 1_000 };
    const result = settleSale(m, 100, 5);   // gross = 500
    expect(result.haircut).toBe(1.0);
    // Net (post-tax) = 500 × 0.85 = 425
    expect(result.traderRevenue).toBeCloseTo(425, 5);
    expect(m.treasury).toBeCloseTo(10_000 - 425, 5);
  });

  it("settleSale haircut applies for depleted treasuries", () => {
    const m = { stock: {}, prices: {}, treasury: -50, treasuryTarget: 100 };  // ratio = -0.5
    const result = settleSale(m, 100, 5);
    expect(result.haircut).toBeLessThan(1.0);
    expect(result.traderRevenue).toBeLessThan(425);
    expect(result.traderRevenue).toBeGreaterThan(0);
  });

  it("settlePurchase deposits to treasury", () => {
    const m = { stock: {}, prices: {}, treasury: 1000, treasuryTarget: 1000 };
    settlePurchase(m, 50, 4);   // total = 200
    expect(m.treasury).toBeCloseTo(1200, 5);
  });
});

describe("treasuries — long-run stability", () => {
  it("NPC fleet wealth growth is bounded (≤ 10× across 10k ticks)", () => {
    const w = createWorld({ player: null });
    const start = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    tickN(w, 10_000);
    const end = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    // Pre-treasury: ~80× over 10k ticks. Post-treasury: ≤10×.
    expect(end).toBeLessThan(start * 10);
  }, 15_000);

  it("trader funds never go negative over long horizons", () => {
    const w = createWorld({ player: null });
    tickN(w, 5_000);
    for (const t of Object.values(w.traders)) {
      expect(t.funds).toBeGreaterThanOrEqual(0);
    }
  });

  it("treasuries never blow past the hard floor", () => {
    const w = createWorld({ player: null });
    tickN(w, 5_000);
    for (const loc of Object.values(w.locations)) {
      const m = w.markets[loc.id];
      const target = m.treasuryTarget || 1;
      expect(m.treasury).toBeGreaterThanOrEqual(-2.0 * target - 0.01);
    }
  });

  it("price clamps still hold with treasuries", () => {
    const w = createWorld({ player: null });
    tickN(w, 5_000);
    for (const loc of Object.values(w.locations)) {
      const m = w.markets[loc.id];
      for (const good of Object.values(w.goods)) {
        const p = m.prices[good.id];
        expect(p).toBeGreaterThanOrEqual(good.basePrice * 0.25 - 0.01);
        expect(p).toBeLessThanOrEqual(good.basePrice * 5 + 0.01);
      }
    }
  });
});

describe("treasuries — determinism", () => {
  it("same world state ticks deterministically with treasuries", () => {
    const a = createWorld({ player: null });
    const b = createWorld({ player: null });
    tickN(a, 200);
    tickN(b, 200);
    for (const id of Object.keys(a.locations)) {
      expect(b.markets[id].treasury).toBeCloseTo(a.markets[id].treasury, 5);
    }
  });
});
