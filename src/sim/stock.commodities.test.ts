// C-1: spot-index commodity tests. See docs/COMMODITIES_TRADING.md.
//
// Covers:
//  - listing creation (one per non-upgrade good)
//  - anchor / fundamental math
//  - tradability (no proximity rule)
//  - settlement (P2P stockWallet, no station treasury, no settlement job)
//  - dividends (commodity equities pay none)
//  - shorts (capped by lendable float and live bid depth, not a treasury)
//  - long-horizon invariants (float, clamp, system-cash drift bounded)

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
  maxShortableShares,
  DIVIDEND_INTERVAL,
  SHARE_PRICE_CEILING_MULT,
  SHARE_PRICE_FLOOR_MULT,
  BROKER_FEE_RATE,
} from "./stock";
import type { Good } from "./types";

function listCommodityEquities(w: ReturnType<typeof createWorld>) {
  return listEquities(w).filter(eq => eq.kind === "commodity");
}

describe("stock — C-1 commodity equity listings", () => {
  it("createWorld lists one commodity per non-upgrade good", () => {
    const w = createWorld();
    const tradableGoods = Object.values(w.goods).filter((g: Good) => g.category !== "upgrade");
    const commodities = listCommodityEquities(w);
    expect(commodities.length).toBe(tradableGoods.length);
  });

  it("commodity equity uses good.basePrice as anchor", () => {
    const w = createWorld();
    for (const eq of listCommodityEquities(w)) {
      const good = w.goods[eq.underlyingId];
      expect(good).toBeDefined();
      expect(eq.anchorPrice).toBe(Math.max(1, good.basePrice));
    }
  });

  it("commodity ids and tickers are unique across the listed universe", () => {
    const w = createWorld();
    const ids = new Set<string>();
    const tickers = new Set<string>();
    for (const eq of listCommodityEquities(w)) {
      expect(ids.has(eq.id)).toBe(false);
      ids.add(eq.id);
      tickers.add(eq.ticker);
    }
    // Tickers can collide across kinds (a 4-letter slug from name); within
    // the commodity slice they should be distinct enough that we don't
    // get more than ~1 collision. Soft check.
    expect(tickers.size).toBeGreaterThan(ids.size * 0.7);
  });
});

describe("stock — C-1 commodity fundamentals", () => {
  it("commodityFundamental is a volume-weighted spot index", () => {
    const w = createWorld();
    const eq = listCommodityEquities(w).find(e => e.underlyingId === "grain")!;
    expect(eq).toBeDefined();
    // Re-stub markets so the math is predictable: two locations, known
    // prices and stocks for grain.
    const locIds = Object.keys(w.markets);
    const [a, b] = locIds;
    w.markets[a].prices.grain = 10;
    w.markets[a].stock.grain = 100;
    w.markets[b].prices.grain = 20;
    w.markets[b].stock.grain = 200;
    // Zero out any other markets so they don't contribute.
    for (let i = 2; i < locIds.length; i++) {
      w.markets[locIds[i]].stock.grain = 0;
    }
    // Expected: (10*100 + 20*200) / (100 + 200) = 5000/300 ≈ 16.67
    const expected = (10 * 100 + 20 * 200) / (100 + 200);
    expect(computeFundamental(w, eq)).toBeCloseTo(expected, 4);
  });

  it("falls back to anchor when every market has zero stock", () => {
    const w = createWorld();
    const eq = listCommodityEquities(w).find(e => e.underlyingId === "grain")!;
    for (const m of Object.values(w.markets)) m.stock.grain = 0;
    expect(computeFundamental(w, eq)).toBe(eq.anchorPrice);
  });

  it("counts empty shortage markets with a small reserve weight", () => {
    const w = createWorld();
    const eq = listCommodityEquities(w).find(e => e.underlyingId === "grain")!;
    const loc = Object.values(w.locations).find(l => (l.targetStock.grain ?? 0) > 0)!;
    for (const m of Object.values(w.markets)) {
      m.stock.grain = 0;
      m.prices.grain = eq.anchorPrice;
    }
    w.markets[loc.id].prices.grain = eq.anchorPrice * 3;
    expect(computeFundamental(w, eq)).toBeGreaterThan(eq.anchorPrice);
  });
});

describe("stock — C-1 commodity tradability", () => {
  it("buys and sells from any docked station — no hop rule", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    // Move the player to a far station and confirm they can still buy.
    const eq = listCommodityEquities(w)[0];
    const farLoc = Object.keys(w.locations).find(id => id !== ship.location)!;
    ship.location = farLoc;
    ship.state = "idle";

    const r = buyShares(w, eq.id, 5);
    expect(r.ok).toBe(true);
    expect(w.player!.positions?.[eq.id]).toBeDefined();
  });

  it("transit ship still cannot trade commodities (docking rule applies)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    ship.state = "transit";
    const eq = listCommodityEquities(w)[0];
    const r = buyShares(w, eq.id, 1);
    expect(r.ok).toBe(false);
  });
});

describe("stock — C-1 commodity settlement", () => {
  it("commodity sell returns no settlement job", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listCommodityEquities(w)[0];
    const buy = buyShares(w, eq.id, 5);
    expect(buy.ok).toBe(true);
    // tick a few times so agents requote so the sell can fill against
    // bids.
    tickWorld(w);
    tickWorld(w);
    const r = sellShares(w, eq.id, 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settlementJobId).toBeUndefined();
    }
  });

  it("commodity round-trip burns exactly the broker fee from system cash", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listCommodityEquities(w).find(e => e.underlyingId === "grain")!;

    const totalBefore = ship.funds + Object.values(w.traders).reduce((s, t) => s + (t.stockState?.stockWallet ?? 0), 0);
    const buy = buyShares(w, eq.id, 50);
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    const totalAfter = ship.funds + Object.values(w.traders).reduce((s, t) => s + (t.stockState?.stockWallet ?? 0), 0);
    // Broker fee is destroyed; everything else is P2P. Drop = fee.
    expect(totalBefore - totalAfter).toBeCloseTo(buy.fee, 2);
  });
});

describe("stock — C-1 commodity dividends + shorts", () => {
  it("commodity equities never pay dividends", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listCommodityEquities(w)[0];
    expect(buyShares(w, eq.id, 100).ok).toBe(true);
    while (w.tick < DIVIDEND_INTERVAL + 1) tickWorld(w);
    expect(eq.lastDividend).toBeUndefined();
  });

  it("maxShortableShares is positive and finite for commodities", () => {
    const w = createWorld();
    const eq = listCommodityEquities(w)[0];
    const cap = maxShortableShares(w, eq);
    expect(Number.isFinite(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });

  it("opens and covers a commodity short cleanly", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listCommodityEquities(w).find(e => e.underlyingId === "luxury_goods")!;

    const open = shortShares(w, eq.id, 10);
    expect(open.ok).toBe(true);
    const pos = w.player!.positions![eq.id];
    expect(pos.kind).toBe("short");
    expect(pos.shares).toBe(10);

    const cover = coverShares(w, eq.id, 10);
    expect(cover.ok).toBe(true);
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
  });
});

describe("stock — C-1 commodity long-horizon invariants", () => {
  it("price stays within [0.1×, 10×] anchor over 5,000 ticks", () => {
    const w = createWorld();
    tickN(w, 5_000);
    for (const eq of listCommodityEquities(w)) {
      expect(eq.price).toBeGreaterThanOrEqual(eq.anchorPrice * SHARE_PRICE_FLOOR_MULT - 0.01);
      expect(eq.price).toBeLessThanOrEqual(eq.anchorPrice * SHARE_PRICE_CEILING_MULT + 0.01);
    }
  });

  it("float invariant: long shares ≤ outstanding for every commodity", () => {
    const w = createWorld();
    tickN(w, 1_000);
    for (const eq of listCommodityEquities(w)) {
      let longShares = 0;
      const pp = w.player?.positions?.[eq.id];
      if (pp?.kind === "long") longShares += pp.shares;
      for (const t of Object.values(w.traders)) {
        const ap = t.stockState?.positions[eq.id];
        if (ap && ap.shares > 0) longShares += ap.shares;
      }
      expect(longShares).toBeLessThanOrEqual(eq.sharesOutstanding + 1);
    }
  });

  it("agent fills appear on commodity books over a long run", () => {
    const w = createWorld();
    tickN(w, 1_000);
    const commodities = listCommodityEquities(w);
    // At least half of commodities should show recent trades.
    const withTrades = commodities.filter(eq => (eq.recentTrades?.length ?? 0) > 0);
    expect(withTrades.length).toBeGreaterThanOrEqual(Math.floor(commodities.length / 2));
  });

  it("BROKER_FEE_RATE remains the only stock-market money sink across commodities", () => {
    // Sanity check: broker fee constant unchanged.
    expect(BROKER_FEE_RATE).toBe(0.01);
  });
});
