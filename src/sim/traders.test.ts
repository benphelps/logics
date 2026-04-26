import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";

describe("trader-driven convergence", () => {
  it("traders measurably reduce steady-state shortage volume", () => {
    const noTraders = createWorld({ traders: {} });
    const withTraders = createWorld();

    tickN(noTraders, 50);
    tickN(withTraders, 50);

    const noShort = tickN(noTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);
    const yesShort = tickN(withTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);

    expect(yesShort).toBeLessThan(noShort);
  });

  it("traders end up profitable on average over a long run", () => {
    const w = createWorld();
    const startFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    tickN(w, 500);
    const endFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    const cargoValue = Object.values(w.traders).reduce((s, t) => {
      if (!t.cargo) return s;
      const anyPrice = w.goods[t.cargo.good].basePrice;
      return s + t.cargo.qty * anyPrice;
    }, 0);
    expect(endFunds + cargoValue).toBeGreaterThan(startFunds);
  });

  it("flattens prices for a heavily traded good toward the base price", () => {
    const meanAbsDev = (w: ReturnType<typeof createWorld>, good: string) => {
      const base = w.goods[good].basePrice;
      const prices = Object.values(w.markets).map(m => m.prices[good]);
      return prices.reduce((s, p) => s + Math.abs(p - base), 0) / prices.length;
    };
    const noTrade = createWorld({ traders: {} });
    const trade = createWorld();
    tickN(noTrade, 200);
    tickN(trade, 200);
    expect(meanAbsDev(trade, "grain")).toBeLessThan(meanAbsDev(noTrade, "grain"));
  });

});
