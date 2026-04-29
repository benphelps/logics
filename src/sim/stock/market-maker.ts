// Synthetic market-maker — Phase 1 liquidity floor.
//
// One implicit MM per equity, posting a symmetric bid+ask around the current
// fundamental each tick. Quotes carry TTL=1 so they expire at the start of
// the next stock tick when ageOrders() runs, and the MM reposts fresh quotes
// adjusted to the latest fundamental.
//
// The MM does NOT track its own inventory or wallet. When a trade fills
// against an MM quote, the integration layer (stock.ts) routes the cash
// through the underlying entity's treasury — same closed-loop accounting as
// today. This keeps Phase 1 money-flow shape identical; only price formation
// changes.

import type { Equity, World } from "../types";
import { ageOrders, cancelAgentOrders, ensureOrderBook, placeLimitOrder } from "./orderbook";
import { clampSharePrice } from "../stock";

// Half-spread on each side of the current price. ±2% means 4% round-trip
// against the MM — enough that small player trades pay a real spread but
// not so much that the book looks dysfunctional.
export const MM_HALF_SPREAD = 0.02;

// Quote depth on each side. Sized so that the MM is a visible level but
// not a wall that dwarfs ship-agent orders (which post 2-200 shares each).
// Players typically trade in 10-100 share clips so this still covers
// routine fills; bigger orders walk into the agent levels above/below the
// MM, which is the intended price-impact mechanic now that agents exist.
export const MM_QUOTE_DEPTH = 250;

export const SYNTHETIC_MM_AGENT_ID = "synthetic-mm" as const;

// Refresh the MM's quotes for one equity. Anchored on `eq.price` (the most
// recent print) rather than on `computeFundamental` so the MM follows market
// movement instead of dragging the book toward fair-value every tick. The
// EMA in recomputeEquityPrice provides the fundamental gravity separately.
//
// Safe to call any time; cancels prior MM quotes for this equity first.
export function refreshMarketMakerQuotes(world: World, eq: Equity): void {
  // Defensive: drop anything stale this MM left behind.
  cancelAgentOrders(world, eq.id, SYNTHETIC_MM_AGENT_ID);

  const anchor = clampSharePrice(eq, eq.price);
  const bidPrice = clampSharePrice(eq, anchor * (1 - MM_HALF_SPREAD));
  const askPrice = clampSharePrice(eq, anchor * (1 + MM_HALF_SPREAD));

  // If the clamps collapsed the spread (e.g., already pinned at floor or
  // ceiling), nudge each side outward so a cross is still possible. With a
  // 0.1× / 10× anchor band this rarely matters but keeps the invariant
  // bid < ask robust.
  const safeBid = Math.min(bidPrice, askPrice - 0.0001);
  const safeAsk = Math.max(askPrice, bidPrice + 0.0001);

  placeLimitOrder(world, {
    equityId: eq.id,
    side: "bid",
    qty: MM_QUOTE_DEPTH,
    limitPrice: safeBid,
    agentId: SYNTHETIC_MM_AGENT_ID,
    ttl: 1,
  });
  placeLimitOrder(world, {
    equityId: eq.id,
    side: "ask",
    qty: MM_QUOTE_DEPTH,
    limitPrice: safeAsk,
    agentId: SYNTHETIC_MM_AGENT_ID,
    ttl: 1,
  });
}

// Per-tick step: age orders (drop expired MM quotes from prior tick), then
// repost fresh quotes for every equity. Called from tickStockMarket.
export function tickMarketMakers(world: World): void {
  if (!world.equities) return;
  for (const eq of Object.values(world.equities)) {
    const book = ensureOrderBook(world, eq.id);
    ageOrders(book);
    refreshMarketMakerQuotes(world, eq);
  }
}
