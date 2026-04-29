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

// Order size scaling: agent commits at most this fraction of free funds
// (after cashReserveFraction is held back) per order. Combined with
// riskAppetite this gives a per-order cap of ~`risk × MAX_FUNDS_PER_ORDER`
// of free funds.
export const MAX_FUNDS_PER_ORDER = 0.20;

// Value style tunables.
export const VALUE_BID_DISCOUNT = 0.99;     // bid 1% below fair
export const VALUE_ASK_PREMIUM = 1.01;      // ask 1% above fair
export const VALUE_BID_TRIGGER = 0.97;      // post bid when price < fair × this
export const VALUE_ASK_TRIGGER = 1.03;      // post ask when price > fair × this

// Momentum / contrarian: read N most recent trades to determine direction.
export const TREND_LOOKBACK_TRADES = 6;
export const TREND_BIAS_PCT = 0.005;        // trade 0.5% inside the mid in their direction

// Noise: random side, small qty around mid.
export const NOISE_BAND_PCT = 0.015;        // ±1.5% from mid

// --- lazy initialization -------------------------------------------------

const STYLE_CYCLE: AgentStyle[] = ["value", "momentum", "contrarian", "noise"];

// Deterministic init based on the trader id so the same world reproduces
// the same agent personalities run-to-run.
export function initAgent(trader: Trader): ShipTraderState {
  const seed = hashStr(trader.id);
  const rng = mulberry32(seed);
  // Pick a style by hashing into the cycle, then sprinkle some randomness
  // over risk and cash reserve. Risk in [0.1, 0.6], reserve in [0.3, 0.6].
  const style = STYLE_CYCLE[seed % STYLE_CYCLE.length];
  const riskAppetite = 0.1 + rng() * 0.5;
  const cashReserveFraction = 0.3 + rng() * 0.3;
  return {
    style,
    riskAppetite,
    cashReserveFraction,
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

function decideValue(world: World, trader: Trader, eq: Equity, free: number): PlanOrderArgs[] {
  const fair = computeFundamental(world, eq);
  if (fair <= 0) return [];
  const out: PlanOrderArgs[] = [];
  if (eq.price < fair * VALUE_BID_TRIGGER) {
    const bidPrice = fair * VALUE_BID_DISCOUNT;
    const qty = Math.floor((free * MAX_FUNDS_PER_ORDER) / bidPrice);
    if (qty > 0) out.push({ side: "bid", limitPrice: bidPrice, qty });
  }
  if (eq.price > fair * VALUE_ASK_TRIGGER) {
    const askPrice = fair * VALUE_ASK_PREMIUM;
    // Ask qty: need shares to deliver. Cap by held position; agents don't
    // open shorts in Phase 2 (keeps short-funding simple).
    const heldQty = trader.stockState?.positions[eq.id]?.shares ?? 0;
    if (heldQty > 0) {
      out.push({ side: "ask", limitPrice: askPrice, qty: Math.min(heldQty, Math.floor((free * MAX_FUNDS_PER_ORDER) / askPrice)) });
    }
  }
  return out;
}

function decideMomentum(world: World, trader: Trader, eq: Equity, free: number): PlanOrderArgs[] {
  const bias = recentTrendBias(eq);
  if (Math.abs(bias) < 0.1) return [];   // no clear trend → no order
  const mid = eq.price;
  if (bias > 0) {
    // Up trend → chase bid above mid (but below ask side).
    const bidPrice = mid * (1 - TREND_BIAS_PCT);
    const qty = Math.floor((free * MAX_FUNDS_PER_ORDER * Math.abs(bias)) / bidPrice);
    return qty > 0 ? [{ side: "bid", limitPrice: bidPrice, qty }] : [];
  }
  // Down trend → ask below mid.
  const askPrice = mid * (1 + TREND_BIAS_PCT);
  const heldQty = trader.stockState?.positions[eq.id]?.shares ?? 0;
  if (heldQty <= 0) return [];
  const qty = Math.min(heldQty, Math.floor((free * MAX_FUNDS_PER_ORDER * Math.abs(bias)) / askPrice));
  return qty > 0 ? [{ side: "ask", limitPrice: askPrice, qty }] : [];
}

function decideContrarian(world: World, trader: Trader, eq: Equity, free: number): PlanOrderArgs[] {
  const bias = recentTrendBias(eq);
  if (Math.abs(bias) < 0.1) return [];
  const mid = eq.price;
  if (bias > 0) {
    // Up trend → fade with an ask below recent buyers' price.
    const askPrice = mid * (1 + TREND_BIAS_PCT * 2);
    const heldQty = trader.stockState?.positions[eq.id]?.shares ?? 0;
    if (heldQty <= 0) return [];
    const qty = Math.min(heldQty, Math.floor((free * MAX_FUNDS_PER_ORDER * Math.abs(bias)) / askPrice));
    return qty > 0 ? [{ side: "ask", limitPrice: askPrice, qty }] : [];
  }
  // Down trend → fade with a bid below mid (catch the falling knife at a discount).
  const bidPrice = mid * (1 - TREND_BIAS_PCT * 2);
  const qty = Math.floor((free * MAX_FUNDS_PER_ORDER * Math.abs(bias)) / bidPrice);
  return qty > 0 ? [{ side: "bid", limitPrice: bidPrice, qty }] : [];
}

function decideNoise(world: World, trader: Trader, eq: Equity, free: number, rng: () => number): PlanOrderArgs[] {
  // Random side, small qty, within ±NOISE_BAND_PCT of mid.
  const side: "bid" | "ask" = rng() < 0.5 ? "bid" : "ask";
  const offset = (rng() - 0.5) * 2 * NOISE_BAND_PCT;
  const limitPrice = eq.price * (1 + offset);
  const fundsCommit = free * MAX_FUNDS_PER_ORDER * 0.25;   // noise agents commit less
  let qty = Math.floor(fundsCommit / limitPrice);
  if (side === "ask") {
    const heldQty = trader.stockState?.positions[eq.id]?.shares ?? 0;
    if (heldQty <= 0) return [];
    qty = Math.min(qty, heldQty);
  }
  return qty > 0 ? [{ side, limitPrice, qty }] : [];
}

// --- per-tick agent step -------------------------------------------------
// Drives one trader's stock-trading behavior. Called from tickStockMarket.

export function stepAgentTrader(world: World, trader: Trader): void {
  // Player and special-status ships skip — only NPC traders trade equities.
  if (trader.pilot !== "npc") return;
  if (trader.funds <= 0) return;

  const state = ensureAgentState(trader);

  // Cadence: stagger by trader id hash so 75 agents don't all decide on
  // the same tick.
  const offset = hashStr(trader.id) % AGENT_DECISION_INTERVAL;
  if ((world.tick - offset) % AGENT_DECISION_INTERVAL !== 0) return;
  state.lastDecisionAt = world.tick;

  // Free funds = funds × (1 - reserveFraction). Below the operational
  // reserve, the agent doesn't trade equities at all (operating wallet
  // takes priority).
  const free = trader.funds * (1 - state.cashReserveFraction);
  if (free <= 0) return;

  // Iterate equities. Cancel this agent's stale orders for each equity;
  // post a fresh order based on style.
  const rng = mulberry32(hashStr(trader.id) ^ world.tick);

  for (const eq of Object.values(world.equities)) {
    cancelAgentOrders(world, eq.id, trader.id);

    let plans: PlanOrderArgs[];
    switch (state.style) {
      case "value":      plans = decideValue(world, trader, eq, free); break;
      case "momentum":   plans = decideMomentum(world, trader, eq, free); break;
      case "contrarian": plans = decideContrarian(world, trader, eq, free); break;
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
export function stepStockAgents(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.id === SYNTHETIC_MM_AGENT_ID) continue; // safety; MM is not in traders
    stepAgentTrader(world, trader);
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
