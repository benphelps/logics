// C-2: basis-pair tests. See docs/COMMODITIES_TRADING.md.
//
// A basis equity tracks one station's local price for one good. Long the
// listing = bullish on local price for that station. Cash-settled. Same
// orderbook + agents infrastructure as commodity, just a different
// fundamental.

import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import {
  buyShares,
  sellShares,
  shortShares,
  coverShares,
  listEquities,
  computeFundamental,
  parseBasisUnderlying,
  basisSpreadVsSpot,
  BASIS_PAIRS_GLOBAL_CAP,
  SHARE_PRICE_CEILING_MULT,
  SHARE_PRICE_FLOOR_MULT,
  DIVIDEND_INTERVAL,
} from "./stock";

function listBasisEquities(w: ReturnType<typeof createWorld>) {
  return listEquities(w).filter(eq => eq.kind === "basis");
}

describe("stock — C-2 basis pair listings", () => {
  it("createWorld seeds at least one basis pair on the default universe", () => {
    const w = createWorld();
    const pairs = listBasisEquities(w);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThanOrEqual(BASIS_PAIRS_GLOBAL_CAP);
  });

  it("each basis pair has parseable underlyingId pointing to a real station + good", () => {
    const w = createWorld();
    for (const eq of listBasisEquities(w)) {
      const parts = parseBasisUnderlying(eq.underlyingId);
      expect(parts).not.toBeNull();
      if (!parts) continue;
      expect(w.locations[parts.locationId]).toBeDefined();
      expect(w.goods[parts.goodId]).toBeDefined();
    }
  });

  it("basis pairs are unique across (station, good) combinations", () => {
    const w = createWorld();
    const seen = new Set<string>();
    for (const eq of listBasisEquities(w)) {
      const parts = parseBasisUnderlying(eq.underlyingId);
      if (!parts) continue;
      const key = `${parts.locationId}::${parts.goodId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("anchor equals good.basePrice", () => {
    const w = createWorld();
    for (const eq of listBasisEquities(w)) {
      const parts = parseBasisUnderlying(eq.underlyingId)!;
      const good = w.goods[parts.goodId];
      expect(eq.anchorPrice).toBe(Math.max(1, good.basePrice));
    }
  });
});

describe("stock — C-2 basis fundamental", () => {
  it("computeFundamental for a basis listing equals the station's local price for the good", () => {
    const w = createWorld();
    const eq = listBasisEquities(w)[0];
    const parts = parseBasisUnderlying(eq.underlyingId)!;
    const market = w.markets[parts.locationId];
    // Force a known local price.
    market.prices[parts.goodId] = 42;
    expect(computeFundamental(w, eq)).toBe(42);
  });

  it("falls back to anchor when the local market is missing the good", () => {
    const w = createWorld();
    const eq = listBasisEquities(w)[0];
    const parts = parseBasisUnderlying(eq.underlyingId)!;
    // Wipe the price to undefined.
    delete (w.markets[parts.locationId].prices as Record<string, number>)[parts.goodId];
    expect(computeFundamental(w, eq)).toBe(eq.anchorPrice);
  });

  it("basisSpreadVsSpot is positive when local > spot, negative when local < spot", () => {
    const w = createWorld();
    const eq = listBasisEquities(w)[0];
    const parts = parseBasisUnderlying(eq.underlyingId)!;
    // Make the LOCAL station expensive and EVERY OTHER station cheap.
    for (const m of Object.values(w.markets)) {
      m.prices[parts.goodId] = 5;
      m.stock[parts.goodId] = 100;
    }
    w.markets[parts.locationId].prices[parts.goodId] = 30;
    expect(basisSpreadVsSpot(w, eq)).toBeGreaterThan(0);
    // Flip: cheap locally, expensive elsewhere.
    for (const m of Object.values(w.markets)) {
      m.prices[parts.goodId] = 30;
      m.stock[parts.goodId] = 100;
    }
    w.markets[parts.locationId].prices[parts.goodId] = 5;
    expect(basisSpreadVsSpot(w, eq)).toBeLessThan(0);
  });
});

describe("stock — C-2 basis tradability + settlement", () => {
  it("basis pair is tradable from any docked station (no proximity rule)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listBasisEquities(w)[0];
    const parts = parseBasisUnderlying(eq.underlyingId)!;
    // Move player away from the listed station — it should still trade.
    const farLoc = Object.keys(w.locations).find(id => id !== parts.locationId)!;
    ship.location = farLoc;
    ship.state = "idle";
    const r = buyShares(w, eq.id, 5);
    expect(r.ok).toBe(true);
  });

  it("basis sell does not spawn a settlement job", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listBasisEquities(w)[0];
    expect(buyShares(w, eq.id, 5).ok).toBe(true);
    tickWorld(w);
    tickWorld(w);
    const r = sellShares(w, eq.id, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settlementJobId).toBeUndefined();
  });

  it("basis equities never pay dividends", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listBasisEquities(w)[0];
    expect(buyShares(w, eq.id, 50).ok).toBe(true);
    while (w.tick < DIVIDEND_INTERVAL + 1) tickWorld(w);
    expect(eq.lastDividend).toBeUndefined();
  });

  it("opens and covers a basis short cleanly", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listBasisEquities(w)[0];
    expect(shortShares(w, eq.id, 10).ok).toBe(true);
    expect(w.player!.positions![eq.id].kind).toBe("short");
    expect(coverShares(w, eq.id, 10).ok).toBe(true);
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
  });
});

describe("stock — C-2 basis long-horizon invariants", () => {
  it("price stays within [0.1×, 10×] anchor over 3,000 ticks", () => {
    const w = createWorld();
    tickN(w, 3_000);
    for (const eq of listBasisEquities(w)) {
      expect(eq.price).toBeGreaterThanOrEqual(eq.anchorPrice * SHARE_PRICE_FLOOR_MULT - 0.01);
      expect(eq.price).toBeLessThanOrEqual(eq.anchorPrice * SHARE_PRICE_CEILING_MULT + 0.01);
    }
  });

  it("agent fills appear on basis books over a long run", () => {
    const w = createWorld();
    tickN(w, 1_500);
    const pairs = listBasisEquities(w);
    const withTrades = pairs.filter(eq => (eq.recentTrades?.length ?? 0) > 0);
    expect(withTrades.length).toBeGreaterThan(0);
  });
});
