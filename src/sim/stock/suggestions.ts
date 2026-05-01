import type { Equity, EquityId, StockPosition, Trader, TraderId, World } from "../types";
import {
  BROKER_FEE_RATE,
  computeEventAdjustedFundamental,
  equityTradabilityReason,
  listEquities,
  maxShortableShares,
} from "../stock";
import { FUTURES_BROKER_FEE_RATE, markPriceFor, notionalFor } from "./futures";

export type StockExchangeHintAction =
  | "buy"
  | "sell"
  | "short"
  | "cover"
  | "open_long_future"
  | "open_short_future"
  | "close_future"
  | "watch";

export type StockExchangeHintKind =
  | "open_long"
  | "close_long"
  | "open_short"
  | "cover_short"
  | "open_long_future"
  | "open_short_future"
  | "close_future"
  | "watch";

export interface StockExchangeHint {
  equityId: EquityId;
  ticker: string;
  name: string;
  equityKind: Equity["kind"];
  kind: StockExchangeHintKind;
  action: StockExchangeHintAction;
  actionLabel: string;
  reason: string;
  score: number;
  price: number;
  fairValue: number;
  edgePct: number;
  executable: boolean;
  blockReason?: string;
  suggestedUnits?: number;
  unitLabel?: "sh" | "ct";
  suggestedLimitPrice?: number;
  workingOrderSide?: "bid" | "ask";
  workingOrderUnits?: number;
  workingOrderLimitPrice?: number;
  spreadPct?: number;
  positionPnlPct?: number;
}

const LONG_ENTRY_EDGE = 0.07;
const SHORT_ENTRY_EDGE = 0.085;
const FUTURES_ENTRY_EDGE = 0.045;
const WATCH_EDGE = 0.035;
const TAKE_PROFIT_PCT = 0.12;
const STOP_LOSS_PCT = -0.08;
const EXIT_REVERSAL_EDGE = 0.06;
const OPEN_RISK_FRACTION = 0.06;
const SHORT_RISK_FRACTION = 0.04;
const MAX_SHARE_HINT_QTY = 50;
const MAX_FUTURE_HINT_CONTRACTS = 3;

export function getStockExchangeHint(world: World, shipId?: TraderId): StockExchangeHint | null {
  return listStockExchangeHints(world, shipId, 1)[0] ?? null;
}

export function listStockExchangeHints(world: World, shipId?: TraderId, limit = 5): StockExchangeHint[] {
  const ship = selectPlayerShip(world, shipId);
  const hints: StockExchangeHint[] = [];

  for (const eq of listEquities(world)) {
    const hint = eq.kind === "futures"
      ? buildFuturesHint(world, eq, ship)
      : buildShareHint(world, eq, ship);
    if (hint) hints.push(hint);
  }

  hints.sort((a, b) => rankScore(b) - rankScore(a) || a.ticker.localeCompare(b.ticker));
  return hints.slice(0, Math.max(0, limit));
}

function buildShareHint(world: World, eq: Equity, ship: Trader | null): StockExchangeHint | null {
  const fairValue = computeEventAdjustedFundamental(world, eq);
  const edgePct = fairEdge(eq.price, fairValue);
  const position = world.player?.positions?.[eq.id];
  const book = bookSnapshot(world, eq, ship?.id);

  if (position) {
    const access = shareAccess(world, eq, ship);
    return buildPositionHint(eq, position, fairValue, edgePct, access, book, ship);
  }

  const access = shareAccess(world, eq, ship);
  const cash = ship?.funds ?? 0;
  if (edgePct >= LONG_ENTRY_EDGE) {
    const maxByFunds = affordableShares(cash, eq.price, OPEN_RISK_FRACTION);
    const targetUnits = maxByFunds > 0 ? Math.min(maxByFunds, MAX_SHARE_HINT_QTY) : 0;
    const workingUnits = Math.floor(book.playerBidQty);
    const remainingUnits = Math.max(0, targetUnits - workingUnits);
    if (targetUnits > 0 && remainingUnits <= 0) return null;
    const suggestedUnits = remainingUnits > 0 ? Math.max(1, remainingUnits) : 1;
    const suggestedLimitPrice = suggestedShareLimit("buy", eq, fairValue, book);
    const workingOrderLimitPrice = averageLimitPrice(book.playerBidQty, book.playerBidValue);
    return makeHint({
      eq,
      kind: "open_long",
      action: "buy",
      fairValue,
      edgePct,
      score: 1 + edgePct * 8,
      reason: `${eq.ticker} is ${pct(edgePct)} below event-adjusted fair value.${workingUnits > 0 ? ` ${workingUnits.toLocaleString()} sh are already bid.` : ""}`,
      suggestedUnits,
      unitLabel: "sh",
      suggestedLimitPrice,
      executable: access.ok && remainingUnits > 0,
      blockReason: access.blockReason ?? insufficientOpenReason(ship, Math.max(book.askDepth, remainingUnits), maxByFunds, "ask"),
      workingOrderSide: workingUnits > 0 ? "bid" : undefined,
      workingOrderUnits: workingUnits > 0 ? workingUnits : undefined,
      workingOrderLimitPrice,
      spreadPct: book.spreadPct,
    });
  }

  if (edgePct <= -SHORT_ENTRY_EDGE) {
    const maxByRisk = affordableShares(cash, eq.price, SHORT_RISK_FRACTION);
    const maxShortable = maxShortableShares(world, eq, ship?.id);
    const maxAvailable = Math.min(maxByRisk, maxShortable, Math.floor(book.bidDepth), MAX_SHARE_HINT_QTY);
    const suggestedUnits = maxAvailable > 0 ? Math.max(1, maxAvailable) : 1;
    return makeHint({
      eq,
      kind: "open_short",
      action: "short",
      fairValue,
      edgePct,
      score: 1 + Math.abs(edgePct) * 8,
      reason: `${eq.ticker} is ${pct(Math.abs(edgePct))} above event-adjusted fair value.`,
      suggestedUnits,
      unitLabel: "sh",
      executable: access.ok && maxAvailable > 0,
      blockReason: access.blockReason ?? insufficientShortReason(book.bidDepth, maxByRisk, maxShortable),
      spreadPct: book.spreadPct,
    });
  }

  if (Math.abs(edgePct) >= WATCH_EDGE) {
    return makeHint({
      eq,
      kind: "watch",
      action: "watch",
      fairValue,
      edgePct,
      score: Math.abs(edgePct) * 4,
      reason: `${eq.ticker} has a developing ${edgePct > 0 ? "long" : "short"} edge, but it is still below the trade threshold.`,
      executable: false,
      blockReason: access.blockReason,
      spreadPct: book.spreadPct,
    });
  }

  return null;
}

function buildPositionHint(
  eq: Equity,
  position: StockPosition,
  fairValue: number,
  edgePct: number,
  access: AccessState,
  book: BookSnapshot,
  ship: Trader | null,
): StockExchangeHint | null {
  const pnlPct = positionPnlPct(eq, position);
  const workingExitUnits = position.kind === "long" ? Math.floor(book.playerAskQty) : 0;
  const availablePositionShares = Math.max(0, position.shares - workingExitUnits);
  const sideDepth = position.kind === "long" ? book.bidDepth : book.askDepth;
  const suggestedUnits = position.kind === "long"
    ? Math.max(1, Math.floor(availablePositionShares))
    : Math.max(1, Math.floor(Math.min(position.shares, sideDepth > 0 ? sideDepth : position.shares)));
  const depthReason = sideDepth <= 0
    ? `${eq.ticker}'s ${position.kind === "long" ? "bid" : "ask"} side is empty.`
    : undefined;
  const blockReason = access.blockReason ?? depthReason;
  const executable = position.kind === "long" ? access.ok && availablePositionShares > 0 : access.ok && sideDepth > 0;

  if (position.kind === "long") {
    const shouldTakeProfit = pnlPct >= TAKE_PROFIT_PCT && edgePct < LONG_ENTRY_EDGE * 0.5;
    const shouldStop = pnlPct <= STOP_LOSS_PCT && edgePct < LONG_ENTRY_EDGE * 0.5;
    const shouldReverse = edgePct <= -EXIT_REVERSAL_EDGE;
    if (!shouldTakeProfit && !shouldStop && !shouldReverse) return null;
    if (availablePositionShares <= 0) return null;
    const workingOrderLimitPrice = averageLimitPrice(book.playerAskQty, book.playerAskValue);
    return makeHint({
      eq,
      kind: "close_long",
      action: "sell",
      fairValue,
      edgePct,
      score: 1.4 + Math.max(0, pnlPct) * 4 + Math.max(0, -edgePct) * 5,
      reason: shouldReverse
        ? `${eq.ticker} is now ${pct(Math.abs(edgePct))} above fair value; protect the long.${workingExitUnits > 0 ? ` ${workingExitUnits.toLocaleString()} sh are already offered.` : ""}`
        : shouldTakeProfit
          ? `${eq.ticker} long is up ${pct(pnlPct)} and the fair-value edge has cooled.${workingExitUnits > 0 ? ` ${workingExitUnits.toLocaleString()} sh are already offered.` : ""}`
          : `${eq.ticker} long is down ${pct(Math.abs(pnlPct))}; the recovery edge is weak.${workingExitUnits > 0 ? ` ${workingExitUnits.toLocaleString()} sh are already offered.` : ""}`,
      suggestedUnits,
      unitLabel: "sh",
      suggestedLimitPrice: suggestedShareLimit("sell", eq, fairValue, book),
      executable,
      blockReason: access.blockReason,
      workingOrderSide: workingExitUnits > 0 ? "ask" : undefined,
      workingOrderUnits: workingExitUnits > 0 ? workingExitUnits : undefined,
      workingOrderLimitPrice,
      spreadPct: book.spreadPct,
      positionPnlPct: pnlPct,
    });
  }

  const shouldTakeProfit = pnlPct >= TAKE_PROFIT_PCT && edgePct > -SHORT_ENTRY_EDGE * 0.5;
  const shouldStop = pnlPct <= STOP_LOSS_PCT && edgePct > -SHORT_ENTRY_EDGE * 0.5;
  const shouldReverse = edgePct >= EXIT_REVERSAL_EDGE;
  if (!shouldTakeProfit && !shouldStop && !shouldReverse) return null;

  const cash = ship?.funds ?? 0;
  const maxCoverByFunds = affordableShares(cash, eq.price, 1);
  const coverUnits = Math.max(1, Math.floor(Math.min(suggestedUnits, maxCoverByFunds > 0 ? maxCoverByFunds : suggestedUnits)));
  const coverBlock = maxCoverByFunds <= 0
    ? `Need cash to cover ${eq.ticker} at the current ask.`
    : blockReason;

  return makeHint({
    eq,
    kind: "cover_short",
    action: "cover",
    fairValue,
    edgePct,
    score: 1.4 + Math.max(0, pnlPct) * 4 + Math.max(0, edgePct) * 5,
    reason: shouldReverse
      ? `${eq.ticker} is now ${pct(edgePct)} below fair value; cover the short.`
      : shouldTakeProfit
        ? `${eq.ticker} short is up ${pct(pnlPct)} and the downside edge has cooled.`
        : `${eq.ticker} short is down ${pct(Math.abs(pnlPct))}; the overpricing signal is weak.`,
    suggestedUnits: coverUnits,
    unitLabel: "sh",
    suggestedLimitPrice: suggestedShareLimit("cover", eq, fairValue, book),
    executable: executable && maxCoverByFunds > 0,
    blockReason: coverBlock,
    spreadPct: book.spreadPct,
    positionPnlPct: pnlPct,
  });
}

function buildFuturesHint(world: World, eq: Equity, ship: Trader | null): StockExchangeHint | null {
  const c = world.contracts?.[eq.id];
  if (!c || world.tick >= c.expiryTick) return null;
  const fairValue = computeEventAdjustedFundamental(world, eq);
  const edgePct = fairEdge(eq.price, fairValue);
  const position = world.player?.futures?.[eq.id];
  const access = futuresAccess(world, eq, ship, position?.side);

  if (position) {
    const mark = markPriceFor(world, c);
    const pnlPct = position.avgEntryPrice > 0
      ? position.side === "long"
        ? (mark - position.avgEntryPrice) / position.avgEntryPrice
        : (position.avgEntryPrice - mark) / position.avgEntryPrice
      : 0;
    const againstPosition = position.side === "long" ? edgePct <= -FUTURES_ENTRY_EDGE : edgePct >= FUTURES_ENTRY_EDGE;
    const takeProfit = pnlPct >= TAKE_PROFIT_PCT && Math.abs(edgePct) < FUTURES_ENTRY_EDGE;
    const stop = pnlPct <= STOP_LOSS_PCT && againstPosition;
    if (!againstPosition && !takeProfit && !stop) return null;
    return makeHint({
      eq,
      kind: "close_future",
      action: "close_future",
      fairValue,
      edgePct,
      score: 1.3 + Math.abs(edgePct) * 6 + Math.max(0, pnlPct) * 3,
      reason: `${eq.ticker} ${position.side} future should be reviewed; the mark has moved ${pct(pnlPct)} from entry.`,
      suggestedUnits: Math.max(1, Math.floor(position.contracts)),
      unitLabel: "ct",
      executable: access.ok,
      blockReason: access.blockReason,
      positionPnlPct: pnlPct,
    });
  }

  if (Math.abs(edgePct) < FUTURES_ENTRY_EDGE) {
    if (Math.abs(edgePct) >= WATCH_EDGE) {
      return makeHint({
        eq,
        kind: "watch",
        action: "watch",
        fairValue,
        edgePct,
        score: Math.abs(edgePct) * 4,
        reason: `${eq.ticker} future is near an actionable edge; watch the basis into expiry.`,
        executable: false,
        blockReason: access.blockReason,
      });
    }
    return null;
  }

  const side = edgePct > 0 ? "long" : "short";
  const action: StockExchangeHintAction = side === "long" ? "open_long_future" : "open_short_future";
  const notional = notionalFor(world, c, 1);
  const perContract = c.marginFraction * notional + notional * FUTURES_BROKER_FEE_RATE;
  const maxContracts = ship && perContract > 0 ? Math.floor(ship.funds / perContract) : 0;
  const suggestedUnits = maxContracts > 0 ? Math.max(1, Math.min(MAX_FUTURE_HINT_CONTRACTS, Math.floor(maxContracts * 0.35) || 1)) : 1;

  return makeHint({
    eq,
    kind: side === "long" ? "open_long_future" : "open_short_future",
    action,
    fairValue,
    edgePct,
    score: 1 + Math.abs(edgePct) * 7,
    reason: `${eq.ticker} future is ${edgePct > 0 ? pct(edgePct) + " below" : pct(Math.abs(edgePct)) + " above"} event-adjusted fair value.`,
    suggestedUnits,
    unitLabel: "ct",
    executable: access.ok && maxContracts > 0,
    blockReason: access.blockReason ?? (maxContracts <= 0 ? `Need about ${Math.round(perContract).toLocaleString()} credits for margin and fee.` : undefined),
  });
}

interface AccessState {
  ok: boolean;
  blockReason?: string;
}

function shareAccess(world: World, eq: Equity, ship: Trader | null): AccessState {
  const base = baseAccess(world, eq, ship);
  if (!base.ok) return base;
  return { ok: true };
}

function futuresAccess(world: World, eq: Equity, ship: Trader | null, side?: "long" | "short"): AccessState {
  const base = baseAccess(world, eq, ship);
  if (!base.ok) return base;
  const position = world.player?.futures?.[eq.id];
  if (position && side && position.side !== side) {
    return { ok: false, blockReason: `Currently ${position.side} ${eq.ticker}; close before flipping.` };
  }
  return { ok: true };
}

function baseAccess(world: World, eq: Equity, ship: Trader | null): AccessState {
  if (!ship) return { ok: false, blockReason: "No anchor ship." };
  if (ship.state !== "idle") return { ok: false, blockReason: "Dock before trading." };
  const reason = equityTradabilityReason(world, eq, ship);
  if (reason) return { ok: false, blockReason: reason };
  return { ok: true };
}

interface BookSnapshot {
  bidDepth: number;
  askDepth: number;
  bestBid?: number;
  bestAsk?: number;
  playerBidQty: number;
  playerAskQty: number;
  playerBidValue: number;
  playerAskValue: number;
  spreadPct?: number;
}

function bookSnapshot(world: World, eq: Equity, playerShipId?: TraderId): BookSnapshot {
  const book = world.orderBooks?.[eq.id];
  if (!book) return { bidDepth: 0, askDepth: 0, playerBidQty: 0, playerAskQty: 0, playerBidValue: 0, playerAskValue: 0 };
  const bestBid = book.bids.find(o => o.agentId !== playerShipId)?.limitPrice;
  const bestAsk = book.asks.find(o => o.agentId !== playerShipId)?.limitPrice;
  let bidDepth = 0;
  let askDepth = 0;
  let playerBidQty = 0;
  let playerAskQty = 0;
  let playerBidValue = 0;
  let playerAskValue = 0;
  for (const bid of book.bids) {
    const qty = Math.max(0, bid.qty);
    if (bid.agentId === playerShipId) {
      playerBidQty += qty;
      playerBidValue += qty * bid.limitPrice;
    } else {
      bidDepth += qty;
    }
  }
  for (const ask of book.asks) {
    const qty = Math.max(0, ask.qty);
    if (ask.agentId === playerShipId) {
      playerAskQty += qty;
      playerAskValue += qty * ask.limitPrice;
    } else {
      askDepth += qty;
    }
  }
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : 0;
  const spreadPct = mid > 0 && bestBid != null && bestAsk != null ? (bestAsk - bestBid) / mid : undefined;
  return { bidDepth, askDepth, bestBid, bestAsk, playerBidQty, playerAskQty, playerBidValue, playerAskValue, spreadPct };
}

function suggestedShareLimit(action: "buy" | "sell" | "cover" | "short", eq: Equity, fairValue: number, book: BookSnapshot): number {
  if (action === "buy" || action === "cover") {
    const marketableLimit = book.bestAsk ?? eq.price;
    const fairCap = Math.max(0.01, fairValue * 0.995);
    return roundLimitPrice(Math.min(marketableLimit, fairCap));
  }
  const marketableLimit = book.bestBid ?? eq.price;
  const fairFloor = Math.max(0.01, fairValue * 1.005);
  return roundLimitPrice(Math.max(marketableLimit, fairFloor));
}

function averageLimitPrice(qty: number, value: number): number | undefined {
  return qty > 0 ? roundLimitPrice(value / qty) : undefined;
}

function roundLimitPrice(price: number): number {
  return Math.max(0.01, Math.round(price * 100) / 100);
}

function makeHint(args: {
  eq: Equity;
  kind: StockExchangeHintKind;
  action: StockExchangeHintAction;
  fairValue: number;
  edgePct: number;
  score: number;
  reason: string;
  executable: boolean;
  blockReason?: string;
  suggestedUnits?: number;
  unitLabel?: "sh" | "ct";
  suggestedLimitPrice?: number;
  workingOrderSide?: "bid" | "ask";
  workingOrderUnits?: number;
  workingOrderLimitPrice?: number;
  spreadPct?: number;
  positionPnlPct?: number;
}): StockExchangeHint {
  return {
    equityId: args.eq.id,
    ticker: args.eq.ticker,
    name: args.eq.name,
    equityKind: args.eq.kind,
    kind: args.kind,
    action: args.action,
    actionLabel: actionLabel(args.action, args.suggestedUnits, args.unitLabel),
    reason: args.reason,
    score: args.score,
    price: args.eq.price,
    fairValue: args.fairValue,
    edgePct: args.edgePct,
    executable: args.executable,
    blockReason: args.blockReason,
    suggestedUnits: args.suggestedUnits,
    unitLabel: args.unitLabel,
    suggestedLimitPrice: args.suggestedLimitPrice,
    workingOrderSide: args.workingOrderSide,
    workingOrderUnits: args.workingOrderUnits,
    workingOrderLimitPrice: args.workingOrderLimitPrice,
    spreadPct: args.spreadPct,
    positionPnlPct: args.positionPnlPct,
  };
}

function actionLabel(action: StockExchangeHintAction, units?: number, unitLabel?: "sh" | "ct"): string {
  const qty = units != null && unitLabel ? ` ${Math.max(1, Math.floor(units)).toLocaleString()} ${unitLabel}` : "";
  switch (action) {
    case "buy": return `Buy${qty}`;
    case "sell": return `Sell${qty}`;
    case "short": return `Short${qty}`;
    case "cover": return `Cover${qty}`;
    case "open_long_future": return `Long${qty}`;
    case "open_short_future": return `Short${qty}`;
    case "close_future": return `Close${qty}`;
    case "watch": return "Watch";
  }
}

function selectPlayerShip(world: World, shipId?: TraderId): Trader | null {
  const ids = world.player?.shipIds ?? [];
  const id = shipId && ids.includes(shipId) ? shipId : ids[0];
  return id ? world.traders[id] ?? null : null;
}

function affordableShares(cash: number, price: number, fraction: number): number {
  if (cash <= 0 || price <= 0) return 0;
  return Math.floor((cash * fraction) / (price * (1 + BROKER_FEE_RATE)));
}

function insufficientOpenReason(ship: Trader | null, depth: number, maxByFunds: number, side: "bid" | "ask"): string | undefined {
  if (!ship) return "No anchor ship.";
  if (maxByFunds <= 0) return "Not enough free cash for a conservative starter order.";
  if (Math.floor(depth) <= 0) return `The ${side} side is empty right now.`;
  return undefined;
}

function insufficientShortReason(depth: number, maxByRisk: number, maxShortable: number): string | undefined {
  if (maxByRisk <= 0) return "Not enough free cash cushion for a fair short.";
  if (maxShortable <= 0) return "No shares are fundable for shorting right now.";
  if (Math.floor(depth) <= 0) return "The bid side is empty right now.";
  return undefined;
}

function fairEdge(price: number, fairValue: number): number {
  if (price <= 0 || !Number.isFinite(price) || !Number.isFinite(fairValue)) return 0;
  return (fairValue - price) / price;
}

function positionPnlPct(eq: Equity, position: StockPosition): number {
  if (position.avgEntryPrice <= 0) return 0;
  if (position.kind === "long") return (eq.price - position.avgEntryPrice) / position.avgEntryPrice;
  return (position.avgEntryPrice - eq.price) / position.avgEntryPrice;
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function rankScore(hint: StockExchangeHint): number {
  return hint.score + (hint.executable ? 0.25 : -0.15);
}
