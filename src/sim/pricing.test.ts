import { describe, it, expect } from "vitest";
import { priceFor, PRICE_CEILING_MULT, PRICE_FLOOR_MULT } from "./pricing";

describe("priceFor", () => {
  it("returns base price when stock equals target", () => {
    expect(priceFor(10, 100, 100)).toBeCloseTo(10, 5);
  });

  it("rises above base when stock is below target", () => {
    const p = priceFor(10, 25, 100);
    expect(p).toBeGreaterThan(10);
    expect(p).toBeLessThan(10 * PRICE_CEILING_MULT);
  });

  it("falls below base when stock is above target", () => {
    const p = priceFor(10, 400, 100);
    expect(p).toBeLessThan(10);
    expect(p).toBeGreaterThan(10 * PRICE_FLOOR_MULT);
  });

  it("approaches scarcity pricing without immediately pinning at the ceiling", () => {
    const p = priceFor(10, 0, 100);
    expect(p).toBeGreaterThan(10);
    expect(p).toBeLessThan(10 * PRICE_CEILING_MULT);
  });

  it("clamps at the floor for massive overstock", () => {
    expect(priceFor(10, 1_000_000, 100)).toBeCloseTo(10 * PRICE_FLOOR_MULT, 5);
  });

  it("is monotonic decreasing in stock", () => {
    let prev = Infinity;
    for (const s of [1, 10, 50, 100, 200, 500, 5000]) {
      const p = priceFor(10, s, 100);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it("returns base when target is zero (no demand modeled)", () => {
    expect(priceFor(10, 50, 0)).toBe(10);
  });
});
