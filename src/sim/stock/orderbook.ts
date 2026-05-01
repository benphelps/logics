// Order book and matching engine — Phase 1 of the real-market stock
// migration (see docs/STOCK_ORDERBOOK.md).
//
// Design constraints:
//   * Price-time priority. Crossing orders match at the *resting* (older)
//     order's limit price.
//   * FIFO within a price level: earliest postedAt fills first; ties broken
//     by order id (deterministic).
//   * Self-trade prevention: an agent's bid never matches its own ask.
//   * Pure-function match step. Mutates the books in place and returns the
//     trades printed this call. Cash flow / position bookkeeping lives in
//     the integration layer (stock.ts), so the matcher stays trivially
//     testable on its own.

import type {
  AgentId,
  BookTrade,
  EquityId,
  Order,
  OrderBook,
  OrderId,
  OrderSide,
  World,
} from "../types";

// --- book lifecycle ------------------------------------------------------

export function ensureOrderBook(world: World, equityId: EquityId): OrderBook {
  if (!world.orderBooks) world.orderBooks = {};
  let book = world.orderBooks[equityId];
  if (!book) {
    book = { equityId, bids: [], asks: [] };
    world.orderBooks[equityId] = book;
  }
  return book;
}

function nextOrderId(world: World): OrderId {
  const n = (world.nextOrderId ?? 1);
  world.nextOrderId = n + 1;
  return `o_${n}`;
}

// --- placing / cancelling ------------------------------------------------

export interface PlaceLimitArgs {
  equityId: EquityId;
  side: OrderSide;
  qty: number;
  limitPrice: number;
  agentId: AgentId;
  ttl?: number;
}

// Insert a limit order into the book at the correct price-time position.
// Does NOT match — call matchBook() (or tickOrderBook) separately so the
// caller can decide when matching happens.
export function placeLimitOrder(world: World, args: PlaceLimitArgs): Order {
  const book = ensureOrderBook(world, args.equityId);
  const order: Order = {
    id: nextOrderId(world),
    equityId: args.equityId,
    side: args.side,
    qty: args.qty,
    limitPrice: args.limitPrice,
    agentId: args.agentId,
    postedAt: world.tick,
    ttl: args.ttl,
  };
  insertSorted(book, order);
  return order;
}

function insertSorted(book: OrderBook, order: Order): void {
  const list = order.side === "bid" ? book.bids : book.asks;
  // bids are price-desc; asks are price-asc. Within a price level, postedAt
  // ascending then id ascending.
  const cmp = order.side === "bid"
    ? (a: Order, b: Order) => b.limitPrice - a.limitPrice || a.postedAt - b.postedAt || (a.id < b.id ? -1 : 1)
    : (a: Order, b: Order) => a.limitPrice - b.limitPrice || a.postedAt - b.postedAt || (a.id < b.id ? -1 : 1);
  // Linear insert is fine — books stay shallow in Phase 1.
  let i = 0;
  while (i < list.length && cmp(list[i], order) <= 0) i++;
  list.splice(i, 0, order);
}

export function cancelOrder(world: World, equityId: EquityId, orderId: OrderId): boolean {
  const book = world.orderBooks?.[equityId];
  if (!book) return false;
  for (const list of [book.bids, book.asks]) {
    const idx = list.findIndex(o => o.id === orderId);
    if (idx >= 0) {
      list.splice(idx, 1);
      return true;
    }
  }
  return false;
}

export function cancelAgentOrders(world: World, equityId: EquityId, agentId: AgentId): number {
  const book = world.orderBooks?.[equityId];
  if (!book) return 0;
  let removed = 0;
  for (const list of [book.bids, book.asks]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].agentId === agentId) {
        list.splice(i, 1);
        removed++;
      }
    }
  }
  return removed;
}

// --- ageing --------------------------------------------------------------

// Decrement TTLs and drop expired orders. Call once per tick before matching.
export function ageOrders(book: OrderBook): number {
  let dropped = 0;
  for (const list of [book.bids, book.asks]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (o.ttl == null) continue;
      o.ttl -= 1;
      if (o.ttl <= 0) {
        list.splice(i, 1);
        dropped++;
      }
    }
  }
  return dropped;
}

// --- matching ------------------------------------------------------------

// Match crossing orders at the top of book until no cross remains. Mutates
// the book in place and returns the trades printed this call.
export function matchBook(book: OrderBook, tick: number): BookTrade[] {
  const trades: BookTrade[] = [];

  while (book.bids.length > 0 && book.asks.length > 0) {
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    if (bestBid.limitPrice < bestAsk.limitPrice) break;

    // Self-trade prevention. If the same agent sits on both sides at the
    // top, drop one (the resting older one) to avoid a wash trade. Choose
    // to drop the side that's older — it had its chance — so newer order
    // can match against the next level.
    if (bestBid.agentId === bestAsk.agentId) {
      if (bestBid.postedAt <= bestAsk.postedAt) book.bids.shift();
      else book.asks.shift();
      continue;
    }

    // Resting price = the order with the earlier postedAt (or smaller id on
    // tie). Whoever arrived first sets the print price.
    const restingIsBid = bestBid.postedAt < bestAsk.postedAt
      || (bestBid.postedAt === bestAsk.postedAt && bestBid.id <= bestAsk.id);
    const price = restingIsBid ? bestBid.limitPrice : bestAsk.limitPrice;
    const qty = Math.min(bestBid.qty, bestAsk.qty);

    trades.push({
      equityId: book.equityId,
      qty,
      price,
      buyerLimitPrice: bestBid.limitPrice,
      sellerLimitPrice: bestAsk.limitPrice,
      buyer: bestBid.agentId,
      seller: bestAsk.agentId,
      takerSide: restingIsBid ? "ask" : "bid",
      tick,
    });

    bestBid.qty -= qty;
    bestAsk.qty -= qty;
    if (bestBid.qty <= 0) book.bids.shift();
    if (bestAsk.qty <= 0) book.asks.shift();
  }

  return trades;
}

// --- market orders -------------------------------------------------------

export interface MarketOrderArgs {
  equityId: EquityId;
  side: OrderSide;
  qty: number;
  agentId: AgentId;
  // Optional cap: refuse fills above (for buys) / below (for sells) this
  // price level. Used by stop/take auto-fires that should reject if the book
  // has moved against them too far. If undefined, walks the entire book.
  worstPrice?: number;
}

export interface MarketOrderResult {
  trades: BookTrade[];
  filled: number;       // qty actually filled
  unfilled: number;     // qty that could not fill against the available book
}

// Read-only walk of the book. Returns the trades the order WOULD print
// without mutating the book — used for preflight checks (e.g. player fund
// adequacy) before commitment.
export function simulateMarketOrder(world: World, args: MarketOrderArgs): MarketOrderResult {
  const book = world.orderBooks?.[args.equityId];
  if (!book) return { trades: [], filled: 0, unfilled: args.qty };
  const trades: BookTrade[] = [];
  let remaining = args.qty;
  const restingList = args.side === "bid" ? book.asks : book.bids;

  for (let i = 0; i < restingList.length && remaining > 0; i++) {
    const top = restingList[i];
    if (top.agentId === args.agentId) continue;
    if (args.worstPrice != null) {
      if (args.side === "bid" && top.limitPrice > args.worstPrice) break;
      if (args.side === "ask" && top.limitPrice < args.worstPrice) break;
    }
    const fillQty = Math.min(remaining, top.qty);
    trades.push({
      equityId: args.equityId,
      qty: fillQty,
      price: top.limitPrice,
      buyerLimitPrice: args.side === "bid" ? args.worstPrice : top.limitPrice,
      sellerLimitPrice: args.side === "bid" ? top.limitPrice : args.worstPrice,
      buyer: args.side === "bid" ? args.agentId : top.agentId,
      seller: args.side === "bid" ? top.agentId : args.agentId,
      takerSide: args.side,
      tick: world.tick,
    });
    remaining -= fillQty;
  }
  return { trades, filled: args.qty - remaining, unfilled: remaining };
}

// Aggress against the book. Walks levels until qty is exhausted, the book is
// empty, or the next level is worse than worstPrice. Self-trades skip the
// matching level entirely — the aggressor jumps to the next.
export function executeMarketOrder(world: World, args: MarketOrderArgs): MarketOrderResult {
  const book = ensureOrderBook(world, args.equityId);
  const trades: BookTrade[] = [];
  let remaining = args.qty;
  // Take from the opposite side.
  const restingList = args.side === "bid" ? book.asks : book.bids;

  while (remaining > 0 && restingList.length > 0) {
    const top = restingList[0];

    // Self-trade: skip this resting order without filling. Pop it so we don't
    // loop forever; the agent paying themselves is a no-op.
    if (top.agentId === args.agentId) {
      restingList.shift();
      continue;
    }

    // worstPrice gate.
    if (args.worstPrice != null) {
      if (args.side === "bid" && top.limitPrice > args.worstPrice) break;
      if (args.side === "ask" && top.limitPrice < args.worstPrice) break;
    }

    const fillQty = Math.min(remaining, top.qty);
    trades.push({
      equityId: args.equityId,
      qty: fillQty,
      price: top.limitPrice,
      buyerLimitPrice: args.side === "bid" ? args.worstPrice : top.limitPrice,
      sellerLimitPrice: args.side === "bid" ? top.limitPrice : args.worstPrice,
      buyer: args.side === "bid" ? args.agentId : top.agentId,
      seller: args.side === "bid" ? top.agentId : args.agentId,
      takerSide: args.side,
      tick: world.tick,
    });
    top.qty -= fillQty;
    remaining -= fillQty;
    if (top.qty <= 0) restingList.shift();
  }

  return { trades, filled: args.qty - remaining, unfilled: remaining };
}

// --- read helpers --------------------------------------------------------

export function bestBid(book: OrderBook): number | null {
  return book.bids[0]?.limitPrice ?? null;
}
export function bestAsk(book: OrderBook): number | null {
  return book.asks[0]?.limitPrice ?? null;
}
export function midPrice(book: OrderBook): number | null {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b == null || a == null) return null;
  return (b + a) / 2;
}
