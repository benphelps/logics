// C-3: futures contract tests.

import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import { buyShares, listEquities } from "./stock";
import {
  ensureFuturesListings,
  closeFuture,
  listOpenContracts,
  listPlayerFutures,
  openLongFuture,
  openShortFuture,
  marginRequired,
  notionalFor,
  unrealizedFuturesPnl,
  NEAR_EXPIRY_TICKS,
  FAR_EXPIRY_TICKS,
  FUTURES_BROKER_FEE_RATE,
  FUTURES_MARGIN_FRACTION_DEFAULT,
} from "./stock/futures";

function totalSystemCash(w: ReturnType<typeof createWorld>): number {
  let total = 0;
  for (const t of Object.values(w.traders)) {
    total += t.funds;
    if (t.stockState) total += t.stockState.stockWallet + (t.stockState.futuresMarginLocked ?? 0);
  }
  for (const m of Object.values(w.markets)) total += m.treasury;
  for (const s of Object.values(w.syndicates)) total += s.treasury;
  for (const r of Object.values(w.player?.reservedFutures ?? {})) total += r;
  return total;
}

describe("stock — C-3 futures listings", () => {
  it("createWorld lists 2 contracts (near + far) per non-upgrade good", () => {
    const w = createWorld();
    const contracts = listOpenContracts(w);
    const goods = Object.values(w.goods).filter(g => g.category !== "upgrade");
    expect(contracts.length).toBe(goods.length * 2);
    // Each good has one near and one far.
    for (const good of goods) {
      const forGood = contracts.filter(c => c.goodId === good.id);
      expect(forGood.length).toBe(2);
      const expiries = forGood.map(c => c.expiryTick).sort((a, b) => a - b);
      expect(expiries[0] - w.tick).toBe(NEAR_EXPIRY_TICKS);
      expect(expiries[1] - w.tick).toBe(FAR_EXPIRY_TICKS);
    }
  });

  it("each futures contract has a corresponding equity row of kind 'futures'", () => {
    const w = createWorld();
    const futuresEquities = listEquities(w).filter(e => e.kind === "futures");
    const contracts = listOpenContracts(w);
    expect(futuresEquities.length).toBe(contracts.length);
    for (const c of contracts) {
      expect(w.equities[c.id]).toBeDefined();
      expect(w.equities[c.id].kind).toBe("futures");
    }
  });

  it("ensureFuturesListings is idempotent", () => {
    const w = createWorld();
    const before = listOpenContracts(w).length;
    ensureFuturesListings(w);
    expect(listOpenContracts(w).length).toBe(before);
  });
});

describe("stock — C-3 futures open / close API", () => {
  it("openLongFuture reserves margin, decrements ship.funds", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    const before = ship.funds;

    const r = openLongFuture(w, c.id, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const margin = marginRequired(w, c, 5);
    const fee = notionalFor(w, c, 5) * FUTURES_BROKER_FEE_RATE;
    expect(ship.funds).toBeCloseTo(before - margin - fee, 2);
    expect(w.player!.reservedFutures?.[c.id]).toBeCloseTo(margin, 4);
    const fp = w.player!.futures?.[c.id];
    expect(fp).toBeDefined();
    expect(fp!.side).toBe("long");
    expect(fp!.contracts).toBe(5);
    expect(fp!.marginPosted).toBeCloseTo(margin, 4);
  });

  it("openShortFuture mirrors openLongFuture for the short side", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w)[0];
    const r = openShortFuture(w, c.id, 3);
    expect(r.ok).toBe(true);
    expect(w.player!.futures?.[c.id]?.side).toBe("short");
    expect(w.player!.futures?.[c.id]?.contracts).toBe(3);
  });

  it("openLongFuture rejects when funds < margin + fee", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 50;
    const c = listOpenContracts(w)[0];
    const r = openLongFuture(w, c.id, 100);
    expect(r.ok).toBe(false);
  });

  it("rejects flips: cannot open short while long, or vice versa", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w)[0];
    expect(openLongFuture(w, c.id, 1).ok).toBe(true);
    const r = openShortFuture(w, c.id, 1);
    expect(r.ok).toBe(false);
  });

  it("rejects regular buyShares on a futures equity", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w)[0];
    // Imported buyShares from stock.ts should refuse:
    const r = buyShares(w, c.id, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Futures/);
  });

  it("closeFuture refunds margin + realized PnL, deletes the position", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openLongFuture(w, c.id, 4).ok).toBe(true);
    const fundsAfterOpen = ship.funds;

    const close = closeFuture(w, c.id);
    expect(close.ok).toBe(true);
    expect(w.player!.futures?.[c.id]).toBeUndefined();
    expect(w.player!.reservedFutures?.[c.id]).toBeUndefined();
    // Closing immediately at the same mark — refund ≈ margin minus the
    // close-side broker fee. Player should have approximately the funds
    // back minus 2× fee (open + close).
    expect(ship.funds).toBeGreaterThan(fundsAfterOpen);
  });
});

describe("stock — C-3 mark-to-market + settlement", () => {
  it("expiry settles to spot: long gains (spot - entry) × size × count, refunds margin", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 5_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    const spotEq = w.equities[c.underlyingEquityId];

    const r = openLongFuture(w, c.id, 2);
    expect(r.ok).toBe(true);
    const entry = w.player!.futures![c.id].avgEntryPrice;
    const margin = w.player!.futures![c.id].marginPosted;
    const fundsAfterOpen = ship.funds;

    // Force the spot upward by 50% so the long is in profit at expiry.
    const targetSpot = entry * 1.5;
    spotEq.price = targetSpot;
    spotEq.anchorPrice = targetSpot; // bypass clamp by re-anchoring

    // Tick to expiry. The futures contract auto-settles inside tickFutures.
    const settleAtTick = c.expiryTick;
    while (w.tick < settleAtTick + 1) {
      // Re-pin the spot before each tick so EMA / fundamental drift
      // doesn't fight us.
      spotEq.price = targetSpot;
      tickWorld(w);
    }
    expect(w.player!.futures?.[c.id]).toBeUndefined();
    expect(w.contracts?.[c.id]).toBeUndefined();
    // PnL ≈ (1.5 entry - entry) × contractSize × 2 = entry × 0.5 × 100 × 2
    // Funds change ≈ +pnl + margin (refund).
    const pnlExpected = (targetSpot - entry) * c.contractSize * 2;
    expect(ship.funds).toBeGreaterThan(fundsAfterOpen + margin + pnlExpected * 0.6);
  });

  it("listing roll: when near expires, a fresh far is listed for that good", () => {
    const w = createWorld();
    const initialContracts = listOpenContracts(w);
    const grainContracts = initialContracts.filter(c => c.goodId === "grain");
    expect(grainContracts.length).toBe(2);
    const nearExpiry = Math.min(...grainContracts.map(c => c.expiryTick));

    while (w.tick < nearExpiry + 1) tickWorld(w);

    // Old near contract is gone; far contract still alive (its expiry is
    // farther out); a NEW far has been listed.
    const after = listOpenContracts(w).filter(c => c.goodId === "grain");
    expect(after.length).toBe(2);
    // The minimum expiry is now the previous "far".
    const newMinExpiry = Math.min(...after.map(c => c.expiryTick));
    expect(newMinExpiry).toBeGreaterThan(nearExpiry);
  });

  it("MtM moves cash into ship.funds when spot rises while long", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    const spotEq = w.equities[c.underlyingEquityId];
    expect(openLongFuture(w, c.id, 5).ok).toBe(true);
    const entry = w.player!.futures![c.id].avgEntryPrice;
    const fundsAfterOpen = ship.funds;

    // Bump the spot up. Tick once past an MtM cadence boundary.
    spotEq.price = entry * 2;
    spotEq.anchorPrice = entry * 2;
    // Run several ticks so MTM_INTERVAL_TICKS fires at least once.
    for (let i = 0; i < 8; i++) {
      spotEq.price = entry * 2;
      tickWorld(w);
    }
    expect(ship.funds).toBeGreaterThan(fundsAfterOpen);
  });

  it("system-cash invariant: open + close round-trip burns ≈ 2× broker fee", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    const totalBefore = totalSystemCash(w);
    expect(openLongFuture(w, c.id, 4).ok).toBe(true);
    expect(closeFuture(w, c.id).ok).toBe(true);
    const totalAfter = totalSystemCash(w);
    const burn = totalBefore - totalAfter;
    // Burn should be > 0 and roughly = 2 × notional × fee_rate
    const expected = 2 * notionalFor(w, c, 4) * FUTURES_BROKER_FEE_RATE;
    expect(burn).toBeGreaterThan(0);
    // Generous tolerance — exact value depends on mark drift between open
    // and close.
    expect(burn).toBeLessThan(expected * 1.5 + 1);
  });
});

describe("stock — C-3 long-horizon stress", () => {
  it("listing count remains stable across 5,000 ticks (rolls keep parity)", () => {
    const w = createWorld();
    const goodCount = Object.values(w.goods).filter(g => g.category !== "upgrade").length;
    tickN(w, 5_000);
    const contracts = listOpenContracts(w);
    expect(contracts.length).toBe(goodCount * 2);
    for (const c of contracts) {
      expect(c.expiryTick).toBeGreaterThanOrEqual(w.tick);
      expect(c.marginFraction).toBeCloseTo(FUTURES_MARGIN_FRACTION_DEFAULT, 4);
    }
  });

  it("no NaN / negative-margin / negative-clearing across 3,000 ticks", () => {
    const w = createWorld();
    tickN(w, 3_000);
    for (const c of Object.values(w.contracts ?? {})) {
      expect(Number.isFinite(c.openInterest)).toBe(true);
      expect(c.openInterest).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.clearing)).toBe(true);
    }
    for (const t of Object.values(w.traders)) {
      const margin = t.stockState?.futuresMarginLocked ?? 0;
      expect(margin).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(margin)).toBe(true);
    }
  });

  it("agent activity: at least some futures equities print trades over a long run", () => {
    const w = createWorld();
    tickN(w, 1_500);
    const futuresEquities = listEquities(w).filter(e => e.kind === "futures");
    const withTrades = futuresEquities.filter(eq => (eq.recentTrades?.length ?? 0) > 0);
    expect(withTrades.length).toBeGreaterThan(0);
  });

  it("listPlayerFutures returns the player's open positions", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 5_000_000;
    const grainContract = listOpenContracts(w).find(c => c.goodId === "grain")!;
    const oreContract = listOpenContracts(w).find(c => c.goodId === "ore")!;
    expect(openLongFuture(w, grainContract.id, 1).ok).toBe(true);
    expect(openShortFuture(w, oreContract.id, 1).ok).toBe(true);
    const positions = listPlayerFutures(w);
    expect(positions.length).toBe(2);
    expect(positions.find(p => p.contractId === grainContract.id)?.side).toBe("long");
    expect(positions.find(p => p.contractId === oreContract.id)?.side).toBe("short");
  });

  it("unrealizedFuturesPnl reports current MtM PnL", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openLongFuture(w, c.id, 3).ok).toBe(true);
    const fp = w.player!.futures![c.id];
    // Manually move the spot up.
    w.equities[c.underlyingEquityId].price = fp.avgEntryPrice * 1.2;
    const pnl = unrealizedFuturesPnl(w, fp);
    expect(pnl).toBeGreaterThan(0);
  });
});
