import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetHistoryDbForTests,
  deleteGame,
  flushHistoryFromWorld,
  getHistoryWindow,
  getRecentHistory,
  getRecentLog,
  getRecentTradeRecords,
  getRecentTrades,
  getTradeRecordsBefore,
  hydrateHistoryRings,
  primeHighWater,
  putHistory,
  putLog,
  putTradeRecords,
  putTrades,
} from "./historyDb";
import type { BookTrade, Equity, ShipLogEntry, TradeRecord, Trader, World } from "../sim/types";

beforeEach(async () => {
  await __resetHistoryDbForTests();
});

afterEach(async () => {
  // Close the cached connection first, then drop the underlying database so
  // the next test starts clean. fake-indexeddb persists across tests within
  // a process otherwise.
  await __resetHistoryDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("logics-history");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

function mkEquity(id: string, samples: { tick: number; price: number }[], trades: BookTrade[] = []): Equity {
  return {
    id,
    kind: "station",
    name: id,
    ticker: id.slice(0, 3).toUpperCase(),
    sharesOutstanding: 1000,
    price: samples.at(-1)?.price ?? 100,
    anchorPrice: 100,
    underlyingId: "loc",
    history: [...samples],
    recentTrades: [...trades],
  };
}

function mkTrader(id: string, log: ShipLogEntry[] = []): Trader {
  return {
    id,
    name: id,
    capacity: 100,
    speed: 1,
    fuelCapacity: 50,
    fuelTypes: [{ good: "fuel", perDistance: 1 }],
    currentFuel: { good: "fuel", qty: 50 },
    funds: 1000,
    location: "loc",
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "npc",
    log: [...log],
  };
}

function mkWorld(gameId: string, tick: number, equities: Equity[], traders: Trader[] = []): World {
  const eqMap: Record<string, Equity> = {};
  for (const eq of equities) eqMap[eq.id] = eq;
  const trMap: Record<string, Trader> = {};
  for (const t of traders) trMap[t.id] = t;
  return {
    gameId,
    tick,
    goods: {} as never,
    locations: {} as never,
    markets: {} as never,
    lanes: {} as never,
    traders: trMap,
    player: null,
    jobs: {},
    nextJobId: 1,
    hires: {},
    nextHireId: 1,
    equities: eqMap,
    syndicates: {},
  };
}

function mkTrade(tick: number, equityId: string, qty = 1, price = 100): BookTrade {
  return {
    equityId,
    qty,
    price,
    buyer: "npc-1",
    seller: "npc-2",
    takerSide: "bid",
    tick,
  };
}

describe("historyDb", () => {
  it("round-trips history samples per (gameId, equityId, tick)", async () => {
    await putHistory([
      { gameId: "g1", equityId: "eq1", tick: 1, price: 10 },
      { gameId: "g1", equityId: "eq1", tick: 2, price: 11 },
      { gameId: "g1", equityId: "eq1", tick: 3, price: 12 },
      { gameId: "g1", equityId: "eq2", tick: 1, price: 20 },
      { gameId: "g2", equityId: "eq1", tick: 1, price: 99 },
    ]);

    const recent = await getRecentHistory("g1", "eq1", 10);
    expect(recent.map(s => s.tick)).toEqual([1, 2, 3]);
    expect(recent.map(s => s.price)).toEqual([10, 11, 12]);

    const otherEq = await getRecentHistory("g1", "eq2", 10);
    expect(otherEq).toHaveLength(1);
    expect(otherEq[0].price).toBe(20);

    const otherGame = await getRecentHistory("g2", "eq1", 10);
    expect(otherGame).toHaveLength(1);
    expect(otherGame[0].price).toBe(99);
  });

  it("getRecentHistory returns the LATEST N samples in tick order", async () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({
      gameId: "g1", equityId: "eq1", tick: i, price: i,
    }));
    await putHistory(samples);

    const recent = await getRecentHistory("g1", "eq1", 10);
    expect(recent).toHaveLength(10);
    expect(recent[0].tick).toBe(40);
    expect(recent.at(-1)!.tick).toBe(49);
  });

  it("re-putting the same (gameId, equityId, tick) overwrites — idempotent", async () => {
    await putHistory([{ gameId: "g1", equityId: "eq1", tick: 5, price: 10 }]);
    await putHistory([{ gameId: "g1", equityId: "eq1", tick: 5, price: 99 }]);
    const all = await getRecentHistory("g1", "eq1", 10);
    expect(all).toHaveLength(1);
    expect(all[0].price).toBe(99);
  });

  it("getHistoryWindow returns the inclusive tick range", async () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      gameId: "g1", equityId: "eq1", tick: i, price: i,
    }));
    await putHistory(samples);

    const window = await getHistoryWindow("g1", "eq1", 5, 10);
    expect(window.map(s => s.tick)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("trades round-trip with equity + tick partitioning", async () => {
    await putTrades([
      { ...mkTrade(1, "eq1", 5, 100), gameId: "g1" },
      { ...mkTrade(2, "eq1", 7, 101), gameId: "g1" },
      { ...mkTrade(2, "eq2", 3, 50), gameId: "g1" },
    ]);

    const eq1 = await getRecentTrades("g1", "eq1", 10);
    expect(eq1).toHaveLength(2);
    expect(eq1.map(t => t.qty)).toEqual([5, 7]);

    const eq2 = await getRecentTrades("g1", "eq2", 10);
    expect(eq2).toHaveLength(1);
    expect(eq2[0].qty).toBe(3);
  });

  it("trader log round-trips per (gameId, traderId)", async () => {
    await putLog([
      { gameId: "g1", traderId: "t1", tick: 1, kind: "buy", message: "buy 1" },
      { gameId: "g1", traderId: "t1", tick: 2, kind: "sell", message: "sell 1", tone: "good" },
      { gameId: "g1", traderId: "t2", tick: 1, kind: "depart", message: "depart" },
    ]);

    const t1 = await getRecentLog("g1", "t1", 10);
    expect(t1).toHaveLength(2);
    expect(t1[0].kind).toBe("buy");
    expect(t1[1].tone).toBe("good");

    const t2 = await getRecentLog("g1", "t2", 10);
    expect(t2).toHaveLength(1);
  });

  it("deleteGame cascades across all three stores", async () => {
    await putHistory([
      { gameId: "g1", equityId: "eq1", tick: 1, price: 10 },
      { gameId: "g2", equityId: "eq1", tick: 1, price: 99 },
    ]);
    await putTrades([
      { ...mkTrade(1, "eq1"), gameId: "g1" },
      { ...mkTrade(1, "eq1"), gameId: "g2" },
    ]);
    await putLog([
      { gameId: "g1", traderId: "t1", tick: 1, kind: "buy", message: "x" },
      { gameId: "g2", traderId: "t1", tick: 1, kind: "buy", message: "x" },
    ]);

    await deleteGame("g1");

    expect(await getRecentHistory("g1", "eq1", 10)).toHaveLength(0);
    expect(await getRecentTrades("g1", "eq1", 10)).toHaveLength(0);
    expect(await getRecentLog("g1", "t1", 10)).toHaveLength(0);

    // The other game's data is untouched.
    expect(await getRecentHistory("g2", "eq1", 10)).toHaveLength(1);
    expect(await getRecentTrades("g2", "eq1", 10)).toHaveLength(1);
    expect(await getRecentLog("g2", "t1", 10)).toHaveLength(1);
  });
});

function mkRecord(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    id: overrides.id ?? `tr_${Math.random().toString(36).slice(2, 8)}`,
    tick: overrides.tick ?? 0,
    equityId: overrides.equityId ?? "eq1",
    ticker: overrides.ticker ?? "EQ1",
    action: overrides.action ?? "open_long",
    shares: overrides.shares ?? 10,
    price: overrides.price ?? 100,
    fee: overrides.fee ?? 1,
    cashFlow: overrides.cashFlow ?? -1001,
    ...(overrides.realizedPnl !== undefined ? { realizedPnl: overrides.realizedPnl } : {}),
    ...(overrides.trigger !== undefined ? { trigger: overrides.trigger } : {}),
  };
}

describe("trade ledger", () => {
  it("round-trips per (gameId, shipId) — getRecentTradeRecords returns oldest-first within window", async () => {
    await putTradeRecords([
      { ...mkRecord({ id: "r1", tick: 10, ticker: "AAA" }), gameId: "g1", shipId: "s1" },
      { ...mkRecord({ id: "r2", tick: 20, ticker: "BBB" }), gameId: "g1", shipId: "s1" },
      { ...mkRecord({ id: "r3", tick: 15, ticker: "CCC" }), gameId: "g1", shipId: "s2" },
      { ...mkRecord({ id: "r4", tick: 5,  ticker: "DDD" }), gameId: "g2", shipId: "s1" },
    ]);

    const s1 = await getRecentTradeRecords("g1", "s1", 10);
    expect(s1.map(r => r.id)).toEqual(["r1", "r2"]);
    const s2 = await getRecentTradeRecords("g1", "s2", 10);
    expect(s2).toHaveLength(1);
    expect(s2[0].id).toBe("r3");
    const otherGame = await getRecentTradeRecords("g2", "s1", 10);
    expect(otherGame.map(r => r.id)).toEqual(["r4"]);
  });

  it("getTradeRecordsBefore paginates the cross-ship feed newest-first", async () => {
    const records: { gameId: string; shipId: string; record: TradeRecord }[] = [];
    for (let i = 0; i < 25; i++) {
      records.push({
        gameId: "g1", shipId: i % 2 === 0 ? "s1" : "s2",
        record: mkRecord({ id: `r${i}`, tick: i }),
      });
    }
    await putTradeRecords(records.map(r => ({ ...r.record, gameId: r.gameId, shipId: r.shipId })));

    // Page 1: newest-first, before tick 1000 (effectively no upper bound).
    const page1 = await getTradeRecordsBefore("g1", 1000, 10);
    expect(page1.map(r => r.tick)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);

    // Page 2: starting before page1's earliest.
    const page2 = await getTradeRecordsBefore("g1", page1[page1.length - 1].tick, 10);
    expect(page2.map(r => r.tick)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);

    // Page 3: shorter than the requested page size = exhausted region.
    const page3 = await getTradeRecordsBefore("g1", page2[page2.length - 1].tick, 10);
    expect(page3.map(r => r.tick)).toEqual([4, 3, 2, 1, 0]);

    // Past the start: empty.
    const empty = await getTradeRecordsBefore("g1", 0, 10);
    expect(empty).toHaveLength(0);
  });

  it("flushHistoryFromWorld writes ship.stockTrades and post-flush trim caps the ring", async () => {
    const trader: Trader = {
      ...mkTrader("s1"),
      stockTrades: Array.from({ length: 250 }, (_, i) => mkRecord({ id: `r${i}`, tick: i })),
    };
    const world: World = {
      ...mkWorld("g1", 250, [], [trader]),
      player: { funds: 0, shipIds: ["s1"] },
    };

    await flushHistoryFromWorld(world);

    // All 250 entries persisted.
    expect(await getRecentTradeRecords("g1", "s1", 1000)).toHaveLength(250);
    // Post-flush trim drops the in-memory ring to LEDGER_KEEP=100.
    expect(trader.stockTrades).toHaveLength(100);
    expect(trader.stockTrades![0].tick).toBe(150);
    expect(trader.stockTrades![99].tick).toBe(249);
  });

  it("hydrateHistoryRings refills ship.stockTrades with the most recent N", async () => {
    const records = Array.from({ length: 300 }, (_, i) => ({
      ...mkRecord({ id: `r${i}`, tick: i }),
      gameId: "g1", shipId: "s1",
    }));
    await putTradeRecords(records);

    const trader: Trader = { ...mkTrader("s1"), stockTrades: [] };
    const world: World = {
      ...mkWorld("g1", 299, [], [trader]),
      player: { funds: 0, shipIds: ["s1"] },
    };

    await hydrateHistoryRings(world);

    expect(trader.stockTrades).toHaveLength(100);
    expect(trader.stockTrades![0].tick).toBe(200);
    expect(trader.stockTrades![99].tick).toBe(299);
  });

  it("deleteGame purges the ledger", async () => {
    await putTradeRecords([
      { ...mkRecord({ id: "g1r1", tick: 1 }), gameId: "g1", shipId: "s1" },
      { ...mkRecord({ id: "g2r1", tick: 1 }), gameId: "g2", shipId: "s1" },
    ]);

    await deleteGame("g1");

    expect(await getRecentTradeRecords("g1", "s1", 10)).toHaveLength(0);
    expect(await getRecentTradeRecords("g2", "s1", 10)).toHaveLength(1);
  });
});

describe("flushHistoryFromWorld", () => {
  it("writes all in-memory rings to IDB on first flush", async () => {
    const eq = mkEquity("eq1", [
      { tick: 1, price: 10 },
      { tick: 2, price: 11 },
      { tick: 3, price: 12 },
    ], [mkTrade(1, "eq1"), mkTrade(2, "eq1")]);
    const trader = mkTrader("t1", [
      { tick: 1, kind: "buy", message: "buy 1" },
      { tick: 2, kind: "sell", message: "sell 1" },
    ]);
    const world = mkWorld("g1", 3, [eq], [trader]);

    await flushHistoryFromWorld(world);

    expect((await getRecentHistory("g1", "eq1", 10)).map(s => s.tick)).toEqual([1, 2, 3]);
    expect(await getRecentTrades("g1", "eq1", 10)).toHaveLength(2);
    expect(await getRecentLog("g1", "t1", 10)).toHaveLength(2);
  });

  it("dedupes on subsequent flushes via the high-water mark", async () => {
    const eq = mkEquity("eq1", [{ tick: 1, price: 10 }, { tick: 2, price: 11 }]);
    const world = mkWorld("g1", 2, [eq]);

    await flushHistoryFromWorld(world);
    // Flush again with the same world — nothing new to write.
    await flushHistoryFromWorld(world);

    const all = await getRecentHistory("g1", "eq1", 100);
    expect(all).toHaveLength(2);

    // Add a tick and flush again — only the new sample is written.
    eq.history!.push({ tick: 3, price: 12 });
    world.tick = 3;
    await flushHistoryFromWorld(world);

    const after = await getRecentHistory("g1", "eq1", 100);
    expect(after.map(s => s.tick)).toEqual([1, 2, 3]);
  });

  it("serializes concurrent flushes for the same gameId", async () => {
    const eq = mkEquity("eq1", [{ tick: 1, price: 10 }]);
    const world = mkWorld("g1", 1, [eq]);

    const a = flushHistoryFromWorld(world);
    eq.history!.push({ tick: 2, price: 11 });
    world.tick = 2;
    const b = flushHistoryFromWorld(world);

    await Promise.all([a, b]);

    const all = await getRecentHistory("g1", "eq1", 100);
    expect(all.map(s => s.tick)).toEqual([1, 2]);
  });
});

describe("hydrateHistoryRings", () => {
  it("rehydrates equity history, trades, and trader log from IDB", async () => {
    // Set up persisted data.
    const seedEq = mkEquity("eq1", [
      { tick: 1, price: 10 },
      { tick: 2, price: 11 },
      { tick: 3, price: 12 },
    ], [mkTrade(1, "eq1"), mkTrade(3, "eq1")]);
    const seedTrader = mkTrader("t1", [
      { tick: 1, kind: "buy", message: "buy 1" },
      { tick: 2, kind: "sell", message: "sell 1", tone: "good" },
    ]);
    const seedWorld = mkWorld("g1", 3, [seedEq], [seedTrader]);
    await flushHistoryFromWorld(seedWorld);

    // Build a "loaded from save" world: same gameId, but rings are empty
    // (the save snapshot stripped them).
    const eq = mkEquity("eq1", []);
    const trader = mkTrader("t1", []);
    const loaded = mkWorld("g1", 3, [eq], [trader]);

    await hydrateHistoryRings(loaded);

    expect(loaded.equities.eq1.history).toEqual([
      { tick: 1, price: 10 },
      { tick: 2, price: 11 },
      { tick: 3, price: 12 },
    ]);
    expect(loaded.equities.eq1.recentTrades).toHaveLength(2);
    expect(loaded.traders.t1.log).toHaveLength(2);
    expect(loaded.traders.t1.log[1].tone).toBe("good");
  });

  it("filters samples newer than world.tick (defends against pre-save data)", async () => {
    await putHistory([
      { gameId: "g1", equityId: "eq1", tick: 1, price: 10 },
      { gameId: "g1", equityId: "eq1", tick: 2, price: 11 },
      { gameId: "g1", equityId: "eq1", tick: 3, price: 12 },  // past the snapshot
    ]);

    const eq = mkEquity("eq1", []);
    const world = mkWorld("g1", 2, [eq]); // snapshot at tick 2

    await hydrateHistoryRings(world);

    expect(world.equities.eq1.history).toEqual([
      { tick: 1, price: 10 },
      { tick: 2, price: 11 },
    ]);
  });

  it("loads up to the default 100-entry hydrate cap (older bars stay in IDB)", async () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({
      gameId: "g1", equityId: "eq1", tick: i, price: i,
    }));
    await putHistory(samples);

    const eq = mkEquity("eq1", []);
    const world = mkWorld("g1", 299, [eq]);

    await hydrateHistoryRings(world);

    expect(world.equities.eq1.history).toHaveLength(100);
    expect(world.equities.eq1.history![0].tick).toBe(200);
    expect(world.equities.eq1.history![99].tick).toBe(299);
  });

  it("explicit limits still work for callers that want a window", async () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({
      gameId: "g1", equityId: "eq1", tick: i, price: i,
    }));
    await putHistory(samples);

    const eq = mkEquity("eq1", []);
    const world = mkWorld("g1", 299, [eq]);

    await hydrateHistoryRings(world, { historyLimit: 50 });

    expect(world.equities.eq1.history).toHaveLength(50);
    expect(world.equities.eq1.history![0].tick).toBe(250);
    expect(world.equities.eq1.history![49].tick).toBe(299);
  });

  it("waits for an in-flight flush before reading", async () => {
    const eq = mkEquity("eq1", [{ tick: 5, price: 50 }]);
    const world = mkWorld("g1", 5, [eq]);

    // Kick off flush, then immediately hydrate a fresh world with empty rings
    // for the same gameId.
    const flush = flushHistoryFromWorld(world);

    const eq2 = mkEquity("eq1", []);
    const world2 = mkWorld("g1", 5, [eq2]);
    const hydrate = hydrateHistoryRings(world2);

    await Promise.all([flush, hydrate]);

    // hydrate should have seen the flushed sample, not raced to empty.
    expect(world2.equities.eq1.history).toEqual([{ tick: 5, price: 50 }]);
  });

  it("primes the high-water so the next flush only writes new ticks", async () => {
    primeHighWater("g1", 100);
    // Add a sample with tick 100 — should be skipped (not > high-water).
    const eq = mkEquity("eq1", [{ tick: 100, price: 50 }]);
    const world = mkWorld("g1", 100, [eq]);
    await flushHistoryFromWorld(world);

    expect(await getRecentHistory("g1", "eq1", 10)).toHaveLength(0);

    // Tick 101 IS strictly greater than the mark — flushed.
    eq.history!.push({ tick: 101, price: 51 });
    world.tick = 101;
    await flushHistoryFromWorld(world);
    const all = await getRecentHistory("g1", "eq1", 10);
    expect(all.map(s => s.tick)).toEqual([101]);
  });
});
