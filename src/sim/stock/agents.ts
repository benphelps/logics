// Stock-trading agents — Phase 2 of the order-book migration.
// (See docs/STOCK_ORDERBOOK.md for design.)
//
// Each NPC ship can act as a stock-trading agent. Each agent has a style
// (value / momentum / contrarian / noise) that determines how it valuates
// equities and what orders it posts. Decisions run on a staggered cadence
// so all agents don't fire on the same tick.
//
// Cash flow: agent ↔ agent trades are P2P (handled by the integration
// layer in stock.ts when matching emits Trades). Agent ↔ MM trades
// continue to route through the underlying treasury (Phase 1 behavior).

import type {
  AgentPosition,
  AgentStyle,
  Equity,
  ShipTraderState,
  Trader,
  TraderId,
  World,
} from "../types";
import { mulberry32 } from "../gen/rng";
import { computeFundamental } from "../stock";
import { cancelAgentOrders, ensureOrderBook, placeLimitOrder } from "./orderbook";
import { SYNTHETIC_MM_AGENT_ID } from "./market-maker";

// --- tunables ------------------------------------------------------------

export const AGENT_DECISION_INTERVAL = 4;   // each agent decides every Nth tick
export const AGENT_ORDER_TTL = 8;           // agent orders live for N ticks before expiring

// Initial stock-trading wallet for each agent. Lets agents post
// meaningful-sized orders regardless of their cargo wallet's state.
// 100k per agent × ~73 agents = ~7.3M total trading capital across the
// market — enough to quote depth on every equity.
export const AGENT_STOCK_WALLET_INIT = 100_000;

// Order size scaling: agent commits at most this fraction of stockWallet
// per order. Combined with riskAppetite this caps a single order at
// `risk × MAX_FUNDS_PER_ORDER × stockWallet`.
export const MAX_FUNDS_PER_ORDER = 0.20;

// Hard cap on shares per order — keeps high-priced equity orders from
// being whales (one big order) and keeps low-priced equity orders from
// being huge. Combined with the funds cap this gives consistent
// per-order depth across the price spectrum.
export const TARGET_SHARES_PER_ORDER = 50;

function sizedQty(free: number, price: number): number {
  if (price <= 0) return 0;
  const fundsCap = Math.floor((free * MAX_FUNDS_PER_ORDER) / price);
  return Math.min(TARGET_SHARES_PER_ORDER, fundsCap);
}

// Value style: triggers on |price − fair| > 3%. Posts passive limit at a
// fixed offset INSIDE the mid so it sits in the book waiting to be hit.
export const VALUE_PASSIVE_OFFSET = 0.005;  // 0.5% inside mid (bid below, ask above)
export const VALUE_BID_TRIGGER = 0.97;      // undervalued — start buying
export const VALUE_ASK_TRIGGER = 1.03;      // overvalued — start selling

// Momentum / contrarian: read N most recent trades to determine direction.
export const TREND_LOOKBACK_TRADES = 6;
export const MOMENTUM_OFFSET = 0.003;       // 0.3% inside mid — slightly more aggressive than value
export const CONTRARIAN_OFFSET = 0.012;     // 1.2% inside mid — fades, willing to wait further out

// Noise: random side, small qty around mid.
export const NOISE_BAND_MIN = 0.005;        // 0.5% min offset from mid
export const NOISE_BAND_MAX = 0.020;        // 2.0% max offset from mid

// --- lazy initialization -------------------------------------------------

const STYLE_CYCLE: AgentStyle[] = ["value", "momentum", "contrarian", "noise"];

// Deterministic init based on the trader id so the same world reproduces
// the same agent personalities run-to-run.
export function initAgent(trader: Trader): ShipTraderState {
  const seed = hashStr(trader.id);
  const rng = mulberry32(seed);
  // Pick a style by hashing into the cycle, then sprinkle some randomness
  // over risk. Risk in [0.4, 1.0] — bigger range so order sizes vary
  // meaningfully across the agent pool.
  const style = STYLE_CYCLE[seed % STYLE_CYCLE.length];
  const riskAppetite = 0.4 + rng() * 0.6;
  return {
    style,
    riskAppetite,
    stockWallet: AGENT_STOCK_WALLET_INIT,
    positions: {},
  };
}

export function ensureAgentState(trader: Trader): ShipTraderState {
  if (!trader.stockState) trader.stockState = initAgent(trader);
  return trader.stockState;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// --- per-trade position bookkeeping --------------------------------------
// Called from the integration layer (stock.ts) when an agent fills. Updates
// the agent's per-equity AgentPosition with weighted-average entry price
// for adds, FIFO closes for offsets.

export function applyAgentFill(trader: Trader, eqId: string, signedQty: number, price: number, tick: number): void {
  const state = ensureAgentState(trader);
  const cur = state.positions[eqId];
  const nextShares = (cur?.shares ?? 0) + signedQty;
  if (Math.abs(nextShares) < 0.0001) {
    delete state.positions[eqId];
    return;
  }
  if (cur == null) {
    state.positions[eqId] = { shares: signedQty, avgEntryPrice: price, openedAt: tick };
    return;
  }
  // Same sign as before → weighted-average entry price.
  const sameSign = (cur.shares > 0 && signedQty > 0) || (cur.shares < 0 && signedQty < 0);
  if (sameSign) {
    const totalCost = cur.shares * cur.avgEntryPrice + signedQty * price;
    cur.avgEntryPrice = totalCost / nextShares;
    cur.shares = nextShares;
    return;
  }
  // Sign change (a flip): close the old direction at this price and start
  // a new position with the residual.
  cur.shares = nextShares;
  cur.avgEntryPrice = price;
  cur.openedAt = tick;
}

// --- recent-trade trend reader -------------------------------------------

function recentTrendBias(eq: Equity): number {
  const recent = (eq.recentTrades ?? []).slice(-TREND_LOOKBACK_TRADES);
  if (recent.length === 0) return 0;
  let net = 0;
  for (const t of recent) net += t.takerSide === "bid" ? t.qty : -t.qty;
  // Normalize to [-1, 1] range relative to total volume in window.
  const total = recent.reduce((s, t) => s + t.qty, 0) || 1;
  return Math.max(-1, Math.min(1, net / total));
}

// --- decision loops ------------------------------------------------------
// Each style returns the orders to place this decision tick (after the
// agent's prior orders are cancelled). Orders come pre-shaped with TTL,
// agentId, etc. — caller just hands them to placeLimitOrder.

interface PlanOrderArgs {
  side: "bid" | "ask";
  limitPrice: number;
  qty: number;
}

// All four styles post PASSIVE orders — bids strictly below mid, asks
// strictly above mid — so they sit in the book as resting liquidity rather
// than crossing whatever else is there. The differentiation is in WHEN they
// post (style-specific triggers) and HOW FAR from mid (style-specific
// offset). Combined with deterministic per-agent rng noise, this produces
// multiple price levels on each side.

function heldShares(trader: Trader, eqId: string): number {
  return trader.stockState?.positions[eqId]?.shares ?? 0;
}

function decideValue(world: World, trader: Trader, eq: Equity, free: number, rng: () => number): PlanOrderArgs[] {
  const fair = computeFundamental(world, eq);
  if (fair <= 0) return [];
  const mid = eq.price;
  // Small per-agent rng jitter so multiple value agents don't post at
  // exactly the same level (yields a depth ladder instead of one big level).
  const jitter = 1 + (rng() - 0.5) * 0.004;   // ±0.2%
  const out: PlanOrderArgs[] = [];
  if (mid < fair * VALUE_BID_TRIGGER) {
    const bidPrice = mid * (1 - VALUE_PASSIVE_OFFSET) * jitter;
    const qty = sizedQty(free, bidPrice);
    if (qty > 0) out.push({ side: "bid", limitPrice: bidPrice, qty });
  }
  if (mid > fair * VALUE_ASK_TRIGGER) {
    const askPrice = mid * (1 + VALUE_PASSIVE_OFFSET) * jitter;
    const held = heldShares(trader, eq.id);
    if (held > 0) {
      out.push({ side: "ask", limitPrice: askPrice, qty: Math.min(held, sizedQty(free, askPrice)) });
    }
  }
  return out;
}

function decideMomentum(world: World, trader: Trader, eq: Equity, free: number, rng: () => number): PlanOrderArgs[] {
  const bias = recentTrendBias(eq);
  // Even without a clear trend, momentum agents occasionally take liquidity
  // — they're the impatient style. ~25% chance to fire each decision tick.
  if (Math.abs(bias) < 0.1 && rng() > 0.25) return [];
  const mid = eq.price;
  const jitter = 1 + (rng() - 0.5) * 0.004;
  // Direction: follow trend if there is one, else random.
  const direction = bias !== 0 ? Math.sign(bias) : (rng() < 0.5 ? 1 : -1);
  // Momentum is AGGRESSIVE: posts orders that cross the spread, generating
  // trades. Bid above mid for buys (eats asks); ask below mid for sells
  // (eats bids). The MOMENTUM_OFFSET is ABOVE mid for bids here.
  const aggression = MOMENTUM_OFFSET * (1 + Math.abs(bias));   // stronger bias → walk further
  if (direction > 0) {
    const bidPrice = mid * (1 + aggression) * jitter;
    const qty = sizedQty(free, bidPrice);
    return qty > 0 ? [{ side: "bid", limitPrice: bidPrice, qty }] : [];
  }
  const askPrice = mid * (1 - aggression) * jitter;
  const held = heldShares(trader, eq.id);
  if (held <= 0) return [];
  const qty = Math.min(held, sizedQty(free, askPrice));
  return qty > 0 ? [{ side: "ask", limitPrice: askPrice, qty }] : [];
}

function decideContrarian(world: World, trader: Trader, eq: Equity, free: number, rng: () => number): PlanOrderArgs[] {
  const bias = recentTrendBias(eq);
  if (Math.abs(bias) < 0.1) return [];
  const mid = eq.price;
  const jitter = 1 + (rng() - 0.5) * 0.004;
  if (bias > 0) {
    // Up trend → fade with an ask further out (waiting for the trend to push to them).
    const askPrice = mid * (1 + CONTRARIAN_OFFSET) * jitter;
    const held = heldShares(trader, eq.id);
    if (held <= 0) return [];
    const qty = Math.min(held, Math.floor(sizedQty(free, askPrice) * Math.abs(bias)));
    return qty > 0 ? [{ side: "ask", limitPrice: askPrice, qty }] : [];
  }
  // Down trend → fade with a bid further out (catch the falling knife).
  const bidPrice = mid * (1 - CONTRARIAN_OFFSET) * jitter;
  const qty = Math.floor(sizedQty(free, bidPrice) * Math.abs(bias));
  return qty > 0 ? [{ side: "bid", limitPrice: bidPrice, qty }] : [];
}

function decideNoise(world: World, trader: Trader, eq: Equity, free: number, rng: () => number): PlanOrderArgs[] {
  // Random side, random offset. 50% of the time posts AGGRESSIVELY (bid
  // above mid / ask below mid, crossing the spread to take liquidity);
  // 50% of the time posts PASSIVELY (the inverse, providing liquidity).
  // The aggressive half drives volume; the passive half maintains depth.
  const side: "bid" | "ask" = rng() < 0.5 ? "bid" : "ask";
  const aggressive = rng() < 0.5;
  const offset = NOISE_BAND_MIN + rng() * (NOISE_BAND_MAX - NOISE_BAND_MIN);
  const sign = side === "bid"
    ? (aggressive ? +1 : -1)   // bid above mid = aggressive (eats asks); below = passive
    : (aggressive ? -1 : +1);  // ask below mid = aggressive (eats bids); above = passive
  const limitPrice = eq.price * (1 + sign * offset);
  let qty = sizedQty(free, limitPrice);
  if (side === "ask") {
    const held = heldShares(trader, eq.id);
    if (held <= 0) return [];
    qty = Math.min(qty, held);
  }
  return qty > 0 ? [{ side, limitPrice, qty }] : [];
}

// --- per-tick agent step -------------------------------------------------
// Drives one trader's stock-trading behavior. Called from tickStockMarket.

export function stepAgentTrader(world: World, trader: Trader, force = false): void {
  // Player and special-status ships skip — only NPC traders trade equities.
  if (trader.pilot !== "npc") return;

  const state = ensureAgentState(trader);

  // Cadence: stagger by trader id hash so 75 agents don't all decide on
  // the same tick. `force` bypasses cadence for warm-up.
  if (!force) {
    const offset = hashStr(trader.id) % AGENT_DECISION_INTERVAL;
    if ((world.tick - offset) % AGENT_DECISION_INTERVAL !== 0) return;
  }
  state.lastDecisionAt = world.tick;

  // Per-decision trading capacity = stockWallet × riskAppetite. Higher-risk
  // agents commit more of their wallet per round.
  const free = state.stockWallet * state.riskAppetite;
  if (free <= 0) return;

  // Iterate equities. Cancel this agent's stale orders for each equity;
  // post a fresh order based on style.
  const rng = mulberry32(hashStr(trader.id) ^ world.tick);

  for (const eq of Object.values(world.equities)) {
    cancelAgentOrders(world, eq.id, trader.id);

    let plans: PlanOrderArgs[];
    switch (state.style) {
      case "value":      plans = decideValue(world, trader, eq, free, rng); break;
      case "momentum":   plans = decideMomentum(world, trader, eq, free, rng); break;
      case "contrarian": plans = decideContrarian(world, trader, eq, free, rng); break;
      case "noise":      plans = decideNoise(world, trader, eq, free, rng); break;
    }

    for (const p of plans) {
      ensureOrderBook(world, eq.id);
      placeLimitOrder(world, {
        equityId: eq.id,
        side: p.side,
        qty: p.qty,
        limitPrice: p.limitPrice,
        agentId: trader.id,
        ttl: AGENT_ORDER_TTL,
      });
    }
  }
}

// --- public step from tickStockMarket ------------------------------------
export function stepStockAgents(world: World, force = false): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.id === SYNTHETIC_MM_AGENT_ID) continue; // safety; MM is not in traders
    stepAgentTrader(world, trader, force);
  }
}

// World-init seed for the order book: makes EVERY agent post both a bid and
// an ask on every equity using noise-style passive offsets, so the book has
// two-sided depth from frame zero. After this, the regular per-tick
// decision loop runs style-specific logic. Without this, only noise agents
// post initial orders (one random side each), leaving books thin and
// one-sided until enough decision ticks have passed.
export function warmUpBook(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.pilot !== "npc") continue;
    const state = ensureAgentState(trader);
    if (state.stockWallet <= 0) continue;
    const free = state.stockWallet * state.riskAppetite;
    const rng = mulberry32(hashStr(trader.id) ^ 0xa1c1de);

    for (const eq of Object.values(world.equities)) {
      ensureOrderBook(world, eq.id);
      // Bid offset: random 0.5%-2% below mid.
      const bidOffset = NOISE_BAND_MIN + rng() * (NOISE_BAND_MAX - NOISE_BAND_MIN);
      const bidPrice = eq.price * (1 - bidOffset);
      const bidQty = sizedQty(free, bidPrice);
      if (bidQty > 0) {
        placeLimitOrder(world, {
          equityId: eq.id, side: "bid", qty: bidQty, limitPrice: bidPrice,
          agentId: trader.id, ttl: AGENT_ORDER_TTL,
        });
      }

      // Ask offset: random 0.5%-2% above mid. Capped by held shares.
      const heldQty = state.positions[eq.id]?.shares ?? 0;
      if (heldQty <= 0) continue;
      const askOffset = NOISE_BAND_MIN + rng() * (NOISE_BAND_MAX - NOISE_BAND_MIN);
      const askPrice = eq.price * (1 + askOffset);
      const askQty = Math.min(heldQty, sizedQty(free, askPrice));
      if (askQty > 0) {
        placeLimitOrder(world, {
          equityId: eq.id, side: "ask", qty: askQty, limitPrice: askPrice,
          agentId: trader.id, ttl: AGENT_ORDER_TTL,
        });
      }
    }
  }
}

// --- world-creation seed -------------------------------------------------
// Distribute each equity's full sharesOutstanding evenly across NPC agents
// so the book has shares-to-ask from day one. Without this, agents start
// with no positions, can't post asks, and one-sided markets emerge.
//
// Uniform split: each agent gets `floor(sharesOutstanding / N)` shares,
// with the remainder distributed to the first `remainder` agents
// (deterministically by sorted trader id). avgEntryPrice = anchor.
export function seedAgentPositions(world: World): void {
  const npcs = Object.values(world.traders)
    .filter(t => t.pilot === "npc")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (npcs.length === 0) return;

  for (const eq of Object.values(world.equities)) {
    const base = Math.floor(eq.sharesOutstanding / npcs.length);
    const remainder = eq.sharesOutstanding - base * npcs.length;
    for (let i = 0; i < npcs.length; i++) {
      const shares = base + (i < remainder ? 1 : 0);
      if (shares <= 0) continue;
      const state = ensureAgentState(npcs[i]);
      state.positions[eq.id] = {
        shares,
        avgEntryPrice: eq.anchorPrice,
        openedAt: 0,
      };
    }
  }
}

// --- helpers re-exported for the integration layer -----------------------
export function isAgent(world: World, agentId: string): boolean {
  return agentId !== SYNTHETIC_MM_AGENT_ID && world.traders[agentId as TraderId] != null;
}

export function isMarketMaker(agentId: string): boolean {
  return agentId === SYNTHETIC_MM_AGENT_ID;
}

// Helper to read an agent's net long shares for an equity (used by the
// float invariant check in the matching layer).
export function agentLongShares(trader: Trader, eqId: string): number {
  const pos = trader.stockState?.positions[eqId];
  return pos && pos.shares > 0 ? pos.shares : 0;
}

// Type guard for tests + rng access.
export type { AgentPosition };
