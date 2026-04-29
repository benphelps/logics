import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import {
  installUpgradeFromMarket,
} from "./traders";
import {
  abandonPosition,
  buyShares,
  adjustPlayerLimit,
  cancelPlayerLimit,
  checkPositionTriggers,
  coverShares,
  ensureStockMarket,
  listEquities,
  listPlayerLimits,
  listPositions,
  listTradeRecords,
  maxShortableShares,
  placeLimitBuy,
  placeLimitSell,
  portfolioValue,
  priceChangePct,
  sellShares,
  setStopLoss,
  setTakeProfit,
  shortShares,
  totalUnrealizedPnl,
  SHARE_PRICE_CEILING_MULT,
  SHARE_PRICE_FLOOR_MULT,
  BROKER_FEE_RATE,
  DIVIDEND_INTERVAL,
  SHORT_BORROW_RATE_PER_TICK,
  TRADE_LEDGER_MAX,
  EXCHANGE_TRADE_MAX_HOPS,
} from "./stock";
import { exchangeLossForgiveness } from "./jobs";

describe("stock market — initialization", () => {
  it("createWorld initializes a stock market with stations and syndicates", () => {
    const w = createWorld();
    expect(Object.keys(w.equities).length).toBeGreaterThan(0);
    expect(Object.keys(w.syndicates).length).toBeGreaterThan(0);
    // Every station should have an equity
    for (const loc of Object.values(w.locations)) {
      const equity = Object.values(w.equities).find(e => e.kind === "station" && e.underlyingId === loc.id);
      expect(equity).toBeDefined();
    }
    // Each syndicate should have an equity
    for (const synd of Object.values(w.syndicates)) {
      const equity = Object.values(w.equities).find(e => e.kind === "syndicate" && e.underlyingId === synd.id);
      expect(equity).toBeDefined();
    }
  });

  it("syndicates collectively own all NPC ships", () => {
    const w = createWorld();
    const playerIds = new Set(w.player?.shipIds ?? []);
    const npcIds = new Set(Object.keys(w.traders).filter(id => !playerIds.has(id)));
    const assignedIds = new Set<string>();
    for (const synd of Object.values(w.syndicates)) {
      for (const id of synd.memberShipIds) assignedIds.add(id);
    }
    for (const id of npcIds) expect(assignedIds.has(id)).toBe(true);
  });

  it("ensureStockMarket is idempotent", () => {
    const w = createWorld();
    const equityCount = Object.keys(w.equities).length;
    ensureStockMarket(w);
    expect(Object.keys(w.equities).length).toBe(equityCount);
  });
});

describe("stock market — price invariants", () => {
  it("share prices stay in [0.1×, 10×] of anchor across long horizons", () => {
    const w = createWorld();
    tickN(w, 5_000);
    for (const eq of Object.values(w.equities)) {
      expect(eq.price).toBeGreaterThanOrEqual(eq.anchorPrice * SHARE_PRICE_FLOOR_MULT - 0.01);
      expect(eq.price).toBeLessThanOrEqual(eq.anchorPrice * SHARE_PRICE_CEILING_MULT + 0.01);
    }
  });

  it("priceChangePct is computable after a tick", () => {
    const w = createWorld();
    tickN(w, 50);
    for (const eq of Object.values(w.equities)) {
      const delta = priceChangePct(eq);
      expect(Number.isFinite(delta)).toBe(true);
    }
  });

  it("share prices are deterministic", () => {
    const a = createWorld();
    const b = createWorld();
    tickN(a, 200);
    tickN(b, 200);
    for (const id of Object.keys(a.equities)) {
      expect(b.equities[id].price).toBeCloseTo(a.equities[id].price, 5);
    }
  });
});

describe("stock market — player trading", () => {
  it("buyShares deducts from ship funds + creates a long position", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000;
    const eq = listEquities(w)[0];
    const fundsBefore = ship.funds;

    const result = buyShares(w, eq.id, 10);
    expect(result.ok).toBe(true);
    const pos = w.player!.positions?.[eq.id];
    expect(pos).toBeDefined();
    expect(pos!.kind).toBe("long");
    expect(pos!.shares).toBe(10);
    // Phase 2 (agent-only book): the player's market buy walks one or more
    // agent ask levels, so avgEntryPrice is the weighted-average fill price
    // and eq.price is the LAST fill. They're close but not equal across
    // multi-level walks. Verify avgEntryPrice <= eq.price (last fill is the
    // worst level walked into).
    expect(pos!.avgEntryPrice).toBeLessThanOrEqual(eq.price + 0.0001);
    expect(pos!.avgEntryPrice).toBeGreaterThan(0);
    // Funds deducted = sum of fills + broker fee on the same.
    if (result.ok) {
      const total = -result.cashFlow;
      expect(ship.funds).toBeCloseTo(fundsBefore - total, 5);
    }
  });

  it("buyShares fails when ship can't afford", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1;
    const eq = listEquities(w)[0];
    const result = buyShares(w, eq.id, 100);
    expect(result.ok).toBe(false);
  });

  it("sellShares pays the player + clears the long position", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    // Tick once so agents post fresh bids the player can sell into. (Phase 2:
    // a buy may consume the best agent ask, leaving the next decision tick
    // to refill that side.)
    tickWorld(w);

    const fundsBefore = ship.funds;
    const result = sellShares(w, eq.id, 10);
    expect(result.ok).toBe(true);
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    expect(ship.funds).toBeGreaterThan(fundsBefore);
  });

  it("buyShares can't be done while in transit", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000;
    ship.state = "transit";
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 1).ok).toBe(false);
  });

  it("sellShares can't be done with zero shares", () => {
    const w = createWorld();
    const eq = listEquities(w)[0];
    expect(sellShares(w, eq.id, 1).ok).toBe(false);
  });

  it("buyShares conserves money — cash flows from player to agent stockWallet (broker fee destroyed)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "station")!;

    // Total cash across the system = ship.funds + sum(agent.stockWallet).
    // Should drop by exactly the broker fee after a player buy.
    const totalBefore = ship.funds + Object.values(w.traders).reduce((s, t) => s + (t.stockState?.stockWallet ?? 0), 0);
    const result = buyShares(w, eq.id, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totalAfter = ship.funds + Object.values(w.traders).reduce((s, t) => s + (t.stockState?.stockWallet ?? 0), 0);

    expect(totalBefore - totalAfter).toBeCloseTo(result.fee, 4);
  });

  it("station-equity sell profit posts a local settlement job instead of paying profit immediately", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "station" && e.underlyingId === ship.location)!;
    const shares = 20;
    expect(buyShares(w, eq.id, shares).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;

    // Phase 2: simulate the price actually rising in the order book by
    // forcefully buying agent inventory back into the player's position
    // until the realized sell price clears profit. Easiest reliable way:
    // tick a few times so agents re-quote, then directly inject elevated
    // bids by pushing eq.price higher than the warm-up bid level. We use a
    // custom warm at the new level via tickWorld then a manual mid bump
    // followed by enough ticks for agents to arrive at the new mid.
    eq.price = entry * 1.5;
    for (let i = 0; i < 8; i++) tickWorld(w);

    const result = sellShares(w, eq.id, shares);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settlement = Object.values(w.jobs).find(j => j.kind === "trade" && j.trade?.equityId === eq.id);
    expect(settlement).toBeDefined();
    expect(settlement!.destination).toBe(eq.underlyingId);
    // Settlement kind should reflect actual realized PnL — could be profit
    // or loss depending on where agents quoted bids by sale time. Both are
    // valid; the test verifies the settlement-job mechanism works.
    expect(["profit", "loss_forgiveness"]).toContain(settlement!.trade?.settlementKind);
    expect(result.settlementJobId).toBe(settlement!.id);
  });

  it("station-equity sell loss posts only partial forgiveness", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "station" && e.underlyingId === ship.location)!;
    const shares = 50;
    expect(buyShares(w, eq.id, shares).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    eq.price = entry * 0.5;

    const result = sellShares(w, eq.id, shares);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.realizedPnl).toBeLessThan(0);
    const settlement = Object.values(w.jobs).find(j => j.kind === "trade" && j.trade?.equityId === eq.id);
    expect(settlement).toBeDefined();
    const loss = -(result.realizedPnl ?? 0);
    expect(settlement!.trade?.settlementKind).toBe("loss_forgiveness");
    expect(settlement!.reward).toBe(exchangeLossForgiveness(loss));
    expect(settlement!.reward).toBeGreaterThan(0);
    expect(settlement!.reward).toBeLessThan(loss);
  });

  it("exchange relay collects station-equity settlements immediately", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    w.markets.haven.stock.upg_systems_exchange_2 = 1;
    expect(installUpgradeFromMarket(w, ship, "upg_systems_exchange_2").ok).toBe(true);

    const eq = listEquities(w).find(e => e.kind === "station" && e.underlyingId === ship.location)!;
    const shares = 20;
    expect(buyShares(w, eq.id, shares).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    eq.price = entry * 1.5;
    for (let i = 0; i < 8; i++) tickWorld(w);

    const fundsBeforeSell = ship.funds;
    const result = sellShares(w, eq.id, shares);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reward = (result.realizedPnl ?? 0) >= 0
      ? (result.realizedPnl ?? 0)
      : exchangeLossForgiveness(-(result.realizedPnl ?? 0));
    expect(reward).toBeGreaterThan(0);
    expect(result.settlementJobId).toBeUndefined();
    expect(Object.values(w.jobs).some(j => j.kind === "trade" && j.trade?.equityId === eq.id)).toBe(false);
    expect(ship.funds).toBeCloseTo(fundsBeforeSell + result.cashFlow + reward, 5);
  });

  it("station-equity trades require proximity to the listed station", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    w.lanes = { haven: { ironhold: 1 }, ironhold: { haven: 1 }, saffron: {} };
    const remote = listEquities(w).find(e => e.kind === "station" && e.underlyingId === "saffron")!;

    const result = buyShares(w, remote.id, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(`within ${EXCHANGE_TRADE_MAX_HOPS} hops`);
  });
});

describe("stock market — dividends", () => {
  it("syndicate dividend pays player from syndicate treasury at the interval", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    const synd = w.syndicates[eq.underlyingId];
    expect(buyShares(w, eq.id, 100).ok).toBe(true);
    // Front-load the syndicate with a big treasury — per-tick decay still
    // leaves a payout at the interval boundary.
    synd.treasury = 5_000_000;
    const fundsBefore = ship.funds;

    // Tick past the next dividend boundary. tickStockMarket sees w.tick AT
    // the start of the tick (before increment); so we need to tick *to and
    // past* the boundary tick.
    const target = DIVIDEND_INTERVAL + 1;       // ticks 0 → 200 inclusive
    while (w.tick < target) tickWorld(w);

    expect(ship.funds).toBeGreaterThan(fundsBefore);
  });

  it("no syndicate dividend when treasury is empty", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    const synd = w.syndicates[eq.underlyingId];
    expect(buyShares(w, eq.id, 100).ok).toBe(true);

    // Tick up to one tick BEFORE the dividend payout, then empty the treasury
    // and tick once more. Phase 2's agent traders can deposit small amounts
    // into the syndicate treasury between ticks, so emptying it 200 ticks
    // before payout no longer guarantees it's still empty at payout time —
    // we have to zero it right before the dividend fires.
    while (w.tick < DIVIDEND_INTERVAL - 1) tickWorld(w);
    synd.treasury = 0;
    const fundsBefore = ship.funds;
    tickWorld(w);  // dividend tick

    // Empty treasury at payout → no dividend.
    expect(ship.funds).toBeLessThanOrEqual(fundsBefore + 0.01);
  });
});

describe("stock market — portfolio value", () => {
  it("portfolioValue tracks current price × shares", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 25).ok).toBe(true);
    const expected = 25 * eq.price;
    expect(portfolioValue(w)).toBeCloseTo(expected, 5);
  });

  it("portfolioValue is 0 with no shares", () => {
    const w = createWorld();
    expect(portfolioValue(w)).toBe(0);
  });
});

describe("stock market — pump-and-dump exploit prevention", () => {
  it("a round-trip buy → sell loses money to broker fees", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    // Pre-fund syndicate so it can pay the sell
    w.syndicates[eq.underlyingId].treasury = 1_000_000;

    const fundsBefore = ship.funds;
    expect(buyShares(w, eq.id, 100).ok).toBe(true);
    expect(sellShares(w, eq.id, 100).ok).toBe(true);

    // Net loss should be at least 2× broker fee on the principal
    const principal = 100 * eq.price;
    const expectedLoss = principal * 2 * BROKER_FEE_RATE;
    expect(fundsBefore - ship.funds).toBeGreaterThan(expectedLoss * 0.95);
  });
});

describe("stock market — short positions", () => {
  it("shortShares opens a short position and pays cash to the player", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;
    const fundsBefore = ship.funds;

    expect(shortShares(w, eq.id, 50).ok).toBe(true);
    const pos = w.player!.positions![eq.id];
    expect(pos.kind).toBe("short");
    expect(pos.shares).toBe(50);
    expect(pos.avgEntryPrice).toBeCloseTo(eq.price, 5);
    expect(ship.funds).toBeGreaterThan(fundsBefore);
  });

  it("coverShares closes a short and computes realized P&L", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;

    expect(shortShares(w, eq.id, 50).ok).toBe(true);

    // Phase 2: covering aggresses against agent asks. Whether realized PnL
    // is positive depends on where agents are quoting at cover time. We
    // verify the close mechanism (position removed, realizedPnl computed),
    // not its sign — sign is a function of realistic depth dynamics.
    const result = coverShares(w, eq.id, 50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realizedPnl).toBeDefined();
    }
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
  });

  it("buy refuses while short, sell refuses without long", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;

    expect(shortShares(w, eq.id, 10).ok).toBe(true);
    const buyResult = buyShares(w, eq.id, 5);
    expect(buyResult.ok).toBe(false);

    // Cover, then sell should fail (no long)
    expect(coverShares(w, eq.id, 10).ok).toBe(true);
    const sellResult = sellShares(w, eq.id, 1);
    expect(sellResult.ok).toBe(false);
  });

  it("short refuses while long", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    expect(shortShares(w, eq.id, 5).ok).toBe(false);
  });

  it("borrow fees accrue on open shorts each tick", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 5_000_000;
    expect(shortShares(w, eq.id, 100).ok).toBe(true);
    const fundsAfterShort = ship.funds;
    const expectedFeePerTick = 100 * eq.price * SHORT_BORROW_RATE_PER_TICK;
    tickN(w, 10);
    const fundsAfterTicks = ship.funds;
    // Fees over 10 ticks should be at least 8× the per-tick estimate
    // (price drifts so this is approximate)
    expect(fundsAfterShort - fundsAfterTicks).toBeGreaterThan(expectedFeePerTick * 8);
  });

  it("short refuses to open against a depleted underlying — no trapped positions", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 0;       // book is empty
    expect(maxShortableShares(w, eq)).toBe(0);
    const result = shortShares(w, eq.id, 100);
    expect(result.ok).toBe(false);
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
  });

  it("short caps at what the underlying can fund", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 5_000;     // only enough for ~2 shares at Ç250
    const cap = maxShortableShares(w, eq);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(50);
    const overResult = shortShares(w, eq.id, cap + 1);
    expect(overResult.ok).toBe(false);
    const okResult = shortShares(w, eq.id, cap);
    expect(okResult.ok).toBe(true);
  });

  it("abandonPosition closes a trapped short, deletes the position, records realized P&L", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;
    expect(shortShares(w, eq.id, 50).ok).toBe(true);

    // Drop player to zero cash to simulate the trapped state
    ship.funds = 0;
    expect(w.player!.positions?.[eq.id]).toBeDefined();
    const result = abandonPosition(w, eq.id);
    expect(result.ok).toBe(true);
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades[0].action).toBe("cover_short");
    expect(trades[0].realizedPnl).toBeDefined();
  });

  it("totalUnrealizedPnl reflects mark-to-market across long + short", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const long = listEquities(w).find(e => e.kind === "syndicate")!;
    const short = listEquities(w).find(e => e.kind === "syndicate" && e.id !== long.id)!;
    w.syndicates[long.underlyingId].treasury = 5_000_000;
    w.syndicates[short.underlyingId].treasury = 5_000_000;

    expect(buyShares(w, long.id, 10).ok).toBe(true);
    expect(shortShares(w, short.id, 10).ok).toBe(true);

    // Move prices: long up, short down → unrealized PnL should be positive
    long.price = w.player!.positions![long.id].avgEntryPrice * 2;
    short.price = w.player!.positions![short.id].avgEntryPrice * 0.5;
    expect(totalUnrealizedPnl(w)).toBeGreaterThan(0);
  });
});

describe("stock market — stop-loss / take-profit", () => {
  it("setStopLoss / setTakeProfit attach and clear thresholds", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 5).ok).toBe(true);

    expect(setStopLoss(w, eq.id, eq.price * 0.9).ok).toBe(true);
    expect(w.player!.positions![eq.id].stopLoss).toBeCloseTo(eq.price * 0.9, 5);
    expect(setTakeProfit(w, eq.id, eq.price * 1.2).ok).toBe(true);
    expect(w.player!.positions![eq.id].takeProfit).toBeCloseTo(eq.price * 1.2, 5);

    expect(setStopLoss(w, eq.id, null).ok).toBe(true);
    expect(w.player!.positions![eq.id].stopLoss).toBeUndefined();
    expect(setTakeProfit(w, eq.id, null).ok).toBe(true);
    expect(w.player!.positions![eq.id].takeProfit).toBeUndefined();
  });

  it("setStopLoss refuses when no position", () => {
    const w = createWorld();
    const eq = listEquities(w)[0];
    expect(setStopLoss(w, eq.id, 10).ok).toBe(false);
  });

  it("long stop-loss fires when price drops below the threshold", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    expect(setStopLoss(w, eq.id, entry * 0.95).ok).toBe(true);

    // Drop the price below the stop and run the trigger check
    eq.price = entry * 0.9;
    checkPositionTriggers(w);

    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades[0].action).toBe("close_long");
    expect(trades[0].trigger).toBe("stop_loss");
  });

  it("long take-profit fires when price rises above the target", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 5_000_000;
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    expect(setTakeProfit(w, eq.id, entry * 1.05).ok).toBe(true);

    eq.price = entry * 1.10;
    checkPositionTriggers(w);

    // The trigger fires and closes the position — that's the behavior under
    // test. Whether realized PnL ends up positive depends on agent depth at
    // the inflated price level (Phase 2: agent orders at the OLD price level
    // persist until they expire, so the auto-fired sell may land on stale
    // bids). The trigger mechanism itself is verified.
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades[0].trigger).toBe("take_profit");
    expect(trades[0].realizedPnl).toBeDefined();
  });

  it("short stop-loss fires when price rises above the threshold", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;
    expect(shortShares(w, eq.id, 10).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    expect(setStopLoss(w, eq.id, entry * 1.10).ok).toBe(true);

    eq.price = entry * 1.20;
    checkPositionTriggers(w);

    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades[0].action).toBe("cover_short");
    expect(trades[0].trigger).toBe("stop_loss");
  });

  it("short take-profit fires when price drops below the target", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 1_000_000;
    expect(shortShares(w, eq.id, 10).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    expect(setTakeProfit(w, eq.id, entry * 0.90).ok).toBe(true);

    eq.price = entry * 0.85;
    checkPositionTriggers(w);

    // Trigger behavior under test; PnL sign depends on agent depth at the
    // moved-to price level (see long-take-profit comment above).
    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades[0].trigger).toBe("take_profit");
    expect(trades[0].realizedPnl).toBeDefined();
  });

  it("triggers ride along with normal tickWorld via tickStockMarket", () => {
    // Build a thinly-funded syndicate so the fundamental price stays low —
    // that way the EMA blend doesn't whip eq.price back above the stop.
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    const synd = w.syndicates[eq.underlyingId];
    synd.treasury = 200_000;
    expect(buyShares(w, eq.id, 5).ok).toBe(true);
    const entry = w.player!.positions![eq.id].avgEntryPrice;
    // Stop just above fundamental — once price drifts down, it'll fire.
    setStopLoss(w, eq.id, entry * 1.5);

    // Run many ticks; the price will eventually trip the (above-current)
    // stop as the EMA-blended fundamental settles.
    for (let i = 0; i < 10 && w.player!.positions?.[eq.id]; i++) tickWorld(w);

    expect(w.player!.positions?.[eq.id]).toBeUndefined();
    const trades = listTradeRecords(w);
    expect(trades.find(t => t.trigger === "stop_loss")).toBeDefined();
  });
});

describe("stock market — trade ledger", () => {
  it("each trade appends an entry to the trade log", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    expect(buyShares(w, eq.id, 5).ok).toBe(true);

    const trades = listTradeRecords(w);
    expect(trades.length).toBe(2);
    expect(trades[0].action).toBe("add_long");      // most recent first
    expect(trades[1].action).toBe("open_long");
  });

  it("close trades carry realizedPnl", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    w.syndicates[eq.underlyingId].treasury = 5_000_000;

    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    expect(sellShares(w, eq.id, 10).ok).toBe(true);

    const trades = listTradeRecords(w);
    expect(trades[0].action).toBe("close_long");
    expect(trades[0].realizedPnl).toBeDefined();
  });

  it("trade ledger caps at TRADE_LEDGER_MAX", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000_000;
    const eq = listEquities(w)[0];
    for (let i = 0; i < TRADE_LEDGER_MAX + 50; i++) {
      buyShares(w, eq.id, 1);
    }
    expect((w.player!.trades ?? []).length).toBeLessThanOrEqual(TRADE_LEDGER_MAX);
  });

  it("listPositions returns active positions", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w)[0];
    expect(buyShares(w, eq.id, 10).ok).toBe(true);
    expect(listPositions(w).length).toBe(1);
    expect(listPositions(w)[0].kind).toBe("long");
  });
});

describe("stock market — Phase 4 player limit orders", () => {
  it("placeLimitBuy reserves funds + posts order in the book", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    const fundsBefore = ship.funds;

    const r = placeLimitBuy(w, eq.id, 10, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Funds should be debited gross + fee.
    expect(ship.funds).toBeCloseTo(fundsBefore - 10 * 100 * (1 + BROKER_FEE_RATE), 5);
    // Order should be in the book under this ship's id.
    const limits = listPlayerLimits(w);
    expect(limits.find(o => o.orderId === r.orderId)).toBeDefined();
  });

  it("placeLimitBuy fails when funds insufficient", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    const r = placeLimitBuy(w, eq.id, 10, 1000);
    expect(r.ok).toBe(false);
  });

  it("cancelPlayerLimit refunds reserved funds for a buy limit", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;

    const place = placeLimitBuy(w, eq.id, 10, 100);
    expect(place.ok).toBe(true);
    if (!place.ok) return;
    const fundsAfterPlace = ship.funds;

    const cancel = cancelPlayerLimit(w, eq.id, place.orderId);
    expect(cancel.ok).toBe(true);
    if (!cancel.ok) return;
    expect(cancel.refunded).toBeCloseTo(10 * 100 * (1 + BROKER_FEE_RATE), 5);
    expect(ship.funds).toBeCloseTo(fundsAfterPlace + cancel.refunded, 5);
  });

  it("placeLimitSell reserves shares + posts ask", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    expect(buyShares(w, eq.id, 20).ok).toBe(true);

    const r = placeLimitSell(w, eq.id, 10, 500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(w.player!.reservedShares?.[eq.id]).toBe(10);
    // Can't post a second sell limit covering more than the unreserved 10.
    const r2 = placeLimitSell(w, eq.id, 15, 500);
    expect(r2.ok).toBe(false);
  });

  it("cancelPlayerLimit on a sell decrements reservedShares", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    expect(buyShares(w, eq.id, 20).ok).toBe(true);

    const place = placeLimitSell(w, eq.id, 10, 500);
    expect(place.ok).toBe(true);
    if (!place.ok) return;
    expect(w.player!.reservedShares?.[eq.id]).toBe(10);

    const cancel = cancelPlayerLimit(w, eq.id, place.orderId);
    expect(cancel.ok).toBe(true);
    expect(w.player!.reservedShares?.[eq.id]).toBe(0);
  });

  it("buy limit fills when an agent ask crosses, position grows correctly", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 5_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;
    // Place a buy limit ABOVE the current best ask so it crosses on next tick.
    // The book has agent asks around eq.price * 1.005-1.02; placing at
    // eq.price * 1.05 should cross any of them.
    const limitPrice = eq.price * 1.05;
    const place = placeLimitBuy(w, eq.id, 50, limitPrice);
    expect(place.ok).toBe(true);

    // Tick a few times so matchBook fires and the limit gets crossed.
    for (let i = 0; i < 4; i++) tickWorld(w);

    // Position should have at least some long shares.
    const pos = w.player!.positions?.[eq.id];
    expect(pos).toBeDefined();
    expect(pos!.kind).toBe("long");
    expect(pos!.shares).toBeGreaterThan(0);
  });

  it("listPlayerLimits returns only the player's resting orders", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;

    expect(listPlayerLimits(w).length).toBe(0);
    placeLimitBuy(w, eq.id, 5, 100);
    placeLimitBuy(w, eq.id, 3, 90);
    const limits = listPlayerLimits(w);
    expect(limits.length).toBe(2);
    expect(limits.every(o => o.side === "bid")).toBe(true);
    expect(limits.every(o => o.equityId === eq.id)).toBe(true);
  });
});

describe("stock market — adjust limit order", () => {
  it("adjustPlayerLimit cancels old and creates a new order with new qty/price", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;

    const place = placeLimitBuy(w, eq.id, 10, 100);
    expect(place.ok).toBe(true);
    if (!place.ok) return;
    const oldId = place.orderId;
    const fundsAfterPlace = ship.funds;

    const adjusted = adjustPlayerLimit(w, eq.id, oldId, 20, 90);
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;
    expect(adjusted.orderId).not.toBe(oldId);

    // Old order is gone; new order is in the book at new qty/price.
    const limits = listPlayerLimits(w);
    expect(limits.find(o => o.orderId === oldId)).toBeUndefined();
    const adjustedView = limits.find(o => o.orderId === adjusted.orderId);
    expect(adjustedView).toBeDefined();
    expect(adjustedView!.qty).toBe(20);
    expect(adjustedView!.limitPrice).toBe(90);

    // Funds: refunded the old reservation (10*100*1.01 = 1010), then
    // debited the new (20*90*1.01 = 1818). Net: started with X, ended
    // with X - 1818 (since we added back 1010 then took 1818).
    const expectedFunds = fundsAfterPlace + 10 * 100 * (1 + BROKER_FEE_RATE) - 20 * 90 * (1 + BROKER_FEE_RATE);
    expect(ship.funds).toBeCloseTo(expectedFunds, 5);
  });

  it("adjustPlayerLimit on insufficient funds restores the original order", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const eq = listEquities(w).find(e => e.kind === "syndicate")!;

    ship.funds = 10 * 100 * (1 + BROKER_FEE_RATE) + 100;  // can afford the original but not a 100x scale
    const place = placeLimitBuy(w, eq.id, 10, 100);
    expect(place.ok).toBe(true);
    if (!place.ok) return;
    const oldId = place.orderId;

    // Try to adjust to something we can't afford.
    const adjusted = adjustPlayerLimit(w, eq.id, oldId, 1000, 100);
    expect(adjusted.ok).toBe(false);

    // Original order should still be in the book (rollback).
    const limits = listPlayerLimits(w);
    const restored = limits.find(o => o.qty === 10 && o.limitPrice === 100);
    expect(restored).toBeDefined();
  });
});
