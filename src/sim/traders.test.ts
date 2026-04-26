import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";

describe("trader-driven convergence", () => {
  it("steady-state shortage volume is dramatically lower with traders", () => {
    const noTraders = createWorld({ traders: {} });
    const withTraders = createWorld();

    tickN(noTraders, 50);
    tickN(withTraders, 50);

    const noShort = tickN(noTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);
    const yesShort = tickN(withTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);

    expect(yesShort).toBeLessThan(noShort * 0.5);
  });

  it("traders end up profitable on average over a long run", () => {
    const w = createWorld();
    const startFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    tickN(w, 200);
    const endFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    const cargoValue = Object.values(w.traders).reduce((s, t) => {
      if (!t.cargo) return s;
      const anyPrice = w.goods[t.cargo.good].basePrice;
      return s + t.cargo.qty * anyPrice;
    }, 0);
    expect(endFunds + cargoValue).toBeGreaterThan(startFunds);
  });

  it("flattens prices for a heavily traded good across locations", () => {
    const w = createWorld();
    tickN(w, 200);
    const grainPrices = Object.values(w.markets).map(m => m.prices.grain);
    const max = Math.max(...grainPrices);
    const min = Math.min(...grainPrices);
    const noTradeWorld = createWorld({ traders: {} });
    tickN(noTradeWorld, 200);
    const noTradePrices = Object.values(noTradeWorld.markets).map(m => m.prices.grain);
    const noTradeSpread = Math.max(...noTradePrices) - Math.min(...noTradePrices);
    expect(max - min).toBeLessThan(noTradeSpread);
  });
});
