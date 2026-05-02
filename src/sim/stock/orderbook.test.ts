import { describe, it, expect } from "vitest";
import {
  bestAsk,
  bestBid,
  cancelAgentOrders,
  cancelOrder,
  ensureOrderBook,
  executeMarketOrder,
  matchBook,
  midPrice,
  placeLimitOrder,
} from "./orderbook";
import type { World } from "../types";

// Minimal World stub with just the fields the matcher reads/writes. The
// matcher is pure WRT cash flow; it only needs world.tick and the order
// books / id counter.
function mkWorld(tick = 0): World {
  return {
    gameId: "test",
    tick,
    goods: {} as never,
    locations: {} as never,
    markets: {} as never,
    lanes: {} as never,
    traders: {} as never,
    player: null,
    jobs: {},
    nextJobId: 1,
    hires: {},
    nextHireId: 1,
    equities: {} as never,
    syndicates: {} as never,
  };
}

describe("orderbook — placement + sort", () => {
  it("inserts bids descending by price; asks ascending", () => {
    const w = mkWorld();
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 100, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 105, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 103, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 110, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 107, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 109, agentId: "synthetic-mm" });
    const book = ensureOrderBook(w, "eq_a");
    expect(book.bids.map(o => o.limitPrice)).toEqual([105, 103, 100]);
    expect(book.asks.map(o => o.limitPrice)).toEqual([107, 109, 110]);
  });

  it("FIFO at the same price level — earlier postedAt wins", () => {
    const w = mkWorld(1);
    const o1 = placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 100, agentId: "synthetic-mm" });
    w.tick = 2;
    const o2 = placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 100, agentId: "synthetic-mm" });
    const book = ensureOrderBook(w, "eq_a");
    expect(book.bids.map(o => o.id)).toEqual([o1.id, o2.id]);
  });
});

describe("orderbook — cancel", () => {
  it("removes a single order by id", () => {
    const w = mkWorld();
    const o = placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 100, agentId: "synthetic-mm" });
    expect(cancelOrder(w, "eq_a", o.id)).toBe(true);
    expect(ensureOrderBook(w, "eq_a").bids).toHaveLength(0);
  });

  it("cancelAgentOrders removes every order from one agent on both sides", () => {
    const w = mkWorld();
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 100, agentId: "synthetic-mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 99, agentId: "t_player" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 105, agentId: "synthetic-mm" });
    expect(cancelAgentOrders(w, "eq_a", "synthetic-mm")).toBe(2);
    const book = ensureOrderBook(w, "eq_a");
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(0);
    expect(book.bids[0].agentId).toBe("t_player");
  });
});

describe("orderbook — matching", () => {
  it("crossing bid+ask at same price both fully fill", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 100, agentId: "a" });
    w.tick = 2;
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 100, agentId: "b" });
    const trades = matchBook(ensureOrderBook(w, "eq_a"), w.tick);
    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBe(10);
    expect(trades[0].price).toBe(100);
    expect(trades[0].buyer).toBe("a");
    expect(trades[0].seller).toBe("b");
    expect(trades[0].takerSide).toBe("ask"); // bid was older
    const book = ensureOrderBook(w, "eq_a");
    expect(book.bids).toHaveLength(0);
    expect(book.asks).toHaveLength(0);
  });

  it("crossing bid above ask prints at the resting (older) order's price", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "seller" });
    w.tick = 2;
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 105, agentId: "buyer" });
    const trades = matchBook(ensureOrderBook(w, "eq_a"), w.tick);
    expect(trades).toHaveLength(1);
    expect(trades[0].price).toBe(100); // ask was resting; buyer aggressed
    expect(trades[0].takerSide).toBe("bid");
  });

  it("partial fill leaves the larger order in the book", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 100, agentId: "seller" });
    w.tick = 2;
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 4, limitPrice: 100, agentId: "buyer" });
    const trades = matchBook(ensureOrderBook(w, "eq_a"), w.tick);
    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBe(4);
    const book = ensureOrderBook(w, "eq_a");
    expect(book.bids).toHaveLength(0);
    expect(book.asks).toHaveLength(1);
    expect(book.asks[0].qty).toBe(6);
  });

  it("self-trade prevention: same agent on both sides drops one (older) and continues", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 100, agentId: "a" }); // older bid
    w.tick = 2;
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "a" }); // own ask
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 5, limitPrice: 100, agentId: "b" }); // someone else's bid
    const trades = matchBook(ensureOrderBook(w, "eq_a"), w.tick);
    // The bid_a vs ask_a is dropped (bid_a popped — older), then bid_b matches ask_a.
    expect(trades).toHaveLength(1);
    expect(trades[0].buyer).toBe("b");
    expect(trades[0].seller).toBe("a");
  });
});

describe("orderbook — market orders", () => {
  it("walks multiple levels until qty is filled", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "s1" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 102, agentId: "s2" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 104, agentId: "s3" });
    w.tick = 2;
    const r = executeMarketOrder(w, { equityId: "eq_a", side: "bid", qty: 12, agentId: "buyer" });
    expect(r.filled).toBe(12);
    expect(r.unfilled).toBe(0);
    expect(r.trades).toHaveLength(3);
    expect(r.trades.map(t => t.price)).toEqual([100, 102, 104]);
    expect(r.trades.map(t => t.qty)).toEqual([5, 5, 2]);
    // The third level should still have 3 left.
    const book = ensureOrderBook(w, "eq_a");
    expect(book.asks).toHaveLength(1);
    expect(book.asks[0].qty).toBe(3);
  });

  it("returns unfilled when book has insufficient depth", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 3, limitPrice: 100, agentId: "s1" });
    w.tick = 2;
    const r = executeMarketOrder(w, { equityId: "eq_a", side: "bid", qty: 10, agentId: "buyer" });
    expect(r.filled).toBe(3);
    expect(r.unfilled).toBe(7);
    expect(r.trades).toHaveLength(1);
  });

  it("worstPrice caps the walk", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "s1" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 110, agentId: "s2" });
    w.tick = 2;
    const r = executeMarketOrder(w, { equityId: "eq_a", side: "bid", qty: 10, agentId: "buyer", worstPrice: 105 });
    expect(r.filled).toBe(5);
    expect(r.unfilled).toBe(5);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].price).toBe(100);
  });

  it("self-trade in a market order skips the resting line", () => {
    const w = mkWorld(1);
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "buyer" }); // own
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 102, agentId: "other" });
    w.tick = 2;
    const r = executeMarketOrder(w, { equityId: "eq_a", side: "bid", qty: 5, agentId: "buyer" });
    expect(r.filled).toBe(5);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].seller).toBe("other");
    expect(r.trades[0].price).toBe(102);
  });
});

describe("orderbook — read helpers", () => {
  it("bestBid / bestAsk / midPrice", () => {
    const w = mkWorld();
    expect(midPrice(ensureOrderBook(w, "eq_a"))).toBe(null);
    placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 10, limitPrice: 99, agentId: "mm" });
    placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 10, limitPrice: 101, agentId: "mm" });
    const book = ensureOrderBook(w, "eq_a");
    expect(bestBid(book)).toBe(99);
    expect(bestAsk(book)).toBe(101);
    expect(midPrice(book)).toBe(100);
  });
});

describe("orderbook — determinism", () => {
  it("same input sequence produces identical books and trades", () => {
    const run = () => {
      const w = mkWorld(1);
      placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 100, agentId: "a" });
      placeLimitOrder(w, { equityId: "eq_a", side: "ask", qty: 5, limitPrice: 102, agentId: "b" });
      placeLimitOrder(w, { equityId: "eq_a", side: "bid", qty: 7, limitPrice: 103, agentId: "c" });
      const trades = matchBook(ensureOrderBook(w, "eq_a"), w.tick);
      return { trades, asks: ensureOrderBook(w, "eq_a").asks.map(o => ({ id: o.id, qty: o.qty })) };
    };
    expect(run()).toEqual(run());
  });
});
