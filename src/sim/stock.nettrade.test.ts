// C-5: net-trade modifier tests. Station equity fundamentals are scaled
// by a smoothed netTradeFlow signal — productive stations (net exporter)
// trade at a premium; loss-making (net importer) trade at a discount.

import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import { listEquities, computeFundamental, stationNetTradeMultiplier, NET_TRADE_MULT_CAP } from "./stock";
import { settleSale, settlePurchase, NET_TRADE_DECAY } from "./economy";

describe("stock — C-5 net-trade modifier", () => {
  it("MarketState.netTradeFlow starts at 0 / undefined", () => {
    const w = createWorld();
    for (const m of Object.values(w.markets)) {
      expect(m.netTradeFlow ?? 0).toBe(0);
    }
  });

  it("settlePurchase (cargo leaving) increments netTradeFlow", () => {
    const w = createWorld();
    const m = Object.values(w.markets)[0];
    const before = m.netTradeFlow ?? 0;
    settlePurchase(m, 10, 5);
    expect((m.netTradeFlow ?? 0) - before).toBeCloseTo(50, 5);
  });

  it("settleSale (cargo arriving) decrements netTradeFlow", () => {
    const w = createWorld();
    const m = Object.values(w.markets)[0];
    m.treasury = 1_000_000;
    const before = m.netTradeFlow ?? 0;
    const r = settleSale(m, 10, 5);
    expect((m.netTradeFlow ?? 0) - before).toBeCloseTo(-r.traderRevenue, 4);
  });

  it("netTradeFlow decays each tick", () => {
    const w = createWorld();
    const m = Object.values(w.markets)[0];
    m.netTradeFlow = 1000;
    tickWorld(w);
    // After one tick: ~990
    expect(m.netTradeFlow).toBeCloseTo(1000 * NET_TRADE_DECAY, 1);
  });

  it("stationNetTradeMultiplier returns 1 for non-station equity", () => {
    const w = createWorld();
    const synd = listEquities(w).find(e => e.kind === "syndicate")!;
    expect(stationNetTradeMultiplier(w, synd)).toBe(1);
  });

  it("stationNetTradeMultiplier is positive for net exporters, negative for net importers", () => {
    const w = createWorld();
    const eq = listEquities(w).find(e => e.kind === "station")!;
    const m = w.markets[eq.underlyingId];
    m.netTradeFlow = 50_000;
    expect(stationNetTradeMultiplier(w, eq)).toBeGreaterThan(1);
    m.netTradeFlow = -50_000;
    expect(stationNetTradeMultiplier(w, eq)).toBeLessThan(1);
  });

  it("stationNetTradeMultiplier is bounded by NET_TRADE_MULT_CAP", () => {
    const w = createWorld();
    const eq = listEquities(w).find(e => e.kind === "station")!;
    const m = w.markets[eq.underlyingId];
    m.netTradeFlow = 1e9;
    expect(stationNetTradeMultiplier(w, eq)).toBe(1 + NET_TRADE_MULT_CAP);
    m.netTradeFlow = -1e9;
    expect(stationNetTradeMultiplier(w, eq)).toBe(1 - NET_TRADE_MULT_CAP);
  });

  it("station equity fundamental reflects netTradeFlow modifier", () => {
    const w = createWorld();
    const eq = listEquities(w).find(e => e.kind === "station")!;
    const m = w.markets[eq.underlyingId];
    // Compute with no flow.
    m.netTradeFlow = 0;
    const baseline = computeFundamental(w, eq);
    // Big positive flow.
    m.netTradeFlow = 1_000_000;
    const elevated = computeFundamental(w, eq);
    expect(elevated).toBeGreaterThan(baseline);
    // Big negative flow.
    m.netTradeFlow = -1_000_000;
    const depressed = computeFundamental(w, eq);
    expect(depressed).toBeLessThan(baseline);
  });

  it("over a long run, busy stations (more cargo flow) accumulate signed netTradeFlow", () => {
    const w = createWorld();
    tickN(w, 500);
    let saw = 0;
    for (const m of Object.values(w.markets)) {
      if ((m.netTradeFlow ?? 0) !== 0) saw++;
    }
    expect(saw).toBeGreaterThan(0);
  });
});
