// C-6: sector indices + Treasury Index Note tests.

import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import {
  buyShares,
  sellShares,
  computeFundamental,
  listEquities,
  listSectorIndices,
  SHARE_PRICE_CEILING_MULT,
  SHARE_PRICE_FLOOR_MULT,
} from "./stock";

function listIndices(w: ReturnType<typeof createWorld>) {
  return listEquities(w).filter(e => e.kind === "index");
}

describe("stock — C-6 index listings", () => {
  it("createWorld lists 4 sector indices + 1 Treasury Index Note", () => {
    const w = createWorld();
    const indices = listIndices(w);
    expect(indices.length).toBe(5);
    const ids = new Set(indices.map(i => i.id));
    expect(ids.has("eq_idx_food")).toBe(true);
    expect(ids.has("eq_idx_raw")).toBe(true);
    expect(ids.has("eq_idx_advanced")).toBe(true);
    expect(ids.has("eq_idx_fuel")).toBe(true);
    expect(ids.has("eq_idx_tin")).toBe(true);
    for (const eq of indices) expect(eq.ticker.startsWith("I")).toBe(true);
  });

  it("sector index anchor equals weighted avg of member basePrices", () => {
    const w = createWorld();
    const food = listIndices(w).find(e => e.id === "eq_idx_food")!;
    // Members: grain (8), protein (12), vatmeat (20). Equal weights → 13.33.
    const expected = (8 + 12 + 20) / 3;
    expect(food.anchorPrice).toBeCloseTo(Math.max(1, expected), 4);
  });

  it("sector index price tracks weighted member commodity prices", () => {
    const w = createWorld();
    const food = listIndices(w).find(e => e.id === "eq_idx_food")!;
    // Force commodity prices to known values.
    w.equities["eq_com_grain"].price = 10;
    w.equities["eq_com_protein"].price = 20;
    w.equities["eq_com_vatmeat"].price = 30;
    // Expected = (10 + 20 + 30) / 3 = 20
    expect(computeFundamental(w, food)).toBeCloseTo(20, 4);
  });

  it("treasury index note tracks aggregate station health", () => {
    const w = createWorld();
    const tin = listIndices(w).find(e => e.id === "eq_idx_tin")!;
    expect(tin).toBeDefined();
    // Force every market's treasury to 2× target — the note should be at
    // 2× anchor (clamped at 2×).
    for (const m of Object.values(w.markets)) {
      m.treasury = m.treasuryTarget * 2;
    }
    const fund = computeFundamental(w, tin);
    expect(fund).toBeCloseTo(tin.anchorPrice * 2, 1);
  });
});

describe("stock — C-6 index trading", () => {
  it("buyShares + sellShares work on a sector index (cash settle, no proximity rule)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const food = listIndices(w).find(e => e.id === "eq_idx_food")!;
    expect(buyShares(w, food.id, 10).ok).toBe(true);
    tickWorld(w);
    const r = sellShares(w, food.id, 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settlementJobId).toBeUndefined();
  });

  it("indices are tradable from any docked station", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const otherLoc = Object.keys(w.locations).find(id => id !== ship.location)!;
    ship.location = otherLoc;
    ship.state = "idle";
    const food = listIndices(w).find(e => e.id === "eq_idx_food")!;
    expect(buyShares(w, food.id, 5).ok).toBe(true);
  });
});

describe("stock — C-6 long-horizon invariants", () => {
  it("index prices stay within [0.1×, 10×] anchor across 3,000 ticks", () => {
    const w = createWorld();
    tickN(w, 3_000);
    for (const eq of listIndices(w)) {
      expect(eq.price).toBeGreaterThanOrEqual(eq.anchorPrice * SHARE_PRICE_FLOOR_MULT - 0.01);
      expect(eq.price).toBeLessThanOrEqual(eq.anchorPrice * SHARE_PRICE_CEILING_MULT + 0.01);
    }
  });

  it("sector index def list is non-empty + stable", () => {
    const a = listSectorIndices();
    const b = listSectorIndices();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
