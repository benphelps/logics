// C-3: per-good futures contracts. See docs/COMMODITIES_TRADING.md.
//
// Key shape:
//   - Each contract is a parallel pair: an Equity row (kind="futures")
//     + a FuturesContract entry in world.contracts. The order book +
//     agent loop pick up the equity automatically; the contract holds
//     the margin/expiry/clearing metadata.
//   - Margin = marginFraction × contractSize × spot × count. Reserved
//     on open in player.reservedFutures / agent.futuresMarginLocked,
//     refunded on close/expiry.
//   - Mark-to-market every MTM_INTERVAL_TICKS: track the spot equity's
//     current price, move (mark - lastMarkPrice) × size × signedContracts
//     between counterparties. Symmetric: long gains == short loses.
//   - Settlement at expiry: final MtM to commodityFundamental(spot),
//     refund margin, delete contract.
//
// All cash flows are P2P between player.funds and agent stockWallets
// (margin locked is part of the player's "spent" funds, refunded on
// close/expiry — not destroyed). Total system cash is conserved modulo
// the broker fee on opens/closes.

import type {
  AgentFuturesPosition,
  Equity,
  EquityId,
  FuturesContract,
  FuturesPosition,
  GoodId,
  Trader,
  TraderId,
  World,
} from "../types";
import { ensureOrderBook } from "./orderbook";

// --- tunables ------------------------------------------------------------

export const NEAR_EXPIRY_TICKS = 500;
export const FAR_EXPIRY_TICKS = 1500;
export const FUTURES_MARGIN_FRACTION_DEFAULT = 0.10;
export const FUTURES_MARGIN_FRACTION_PER_GOOD: Partial<Record<GoodId, number>> = {
  // Higher-volatility goods can demand a richer margin. Empty for v1.
};
export const FUTURES_CONTRACT_SIZE_DEFAULT = 100;
export const FUTURES_CONTRACT_SIZE_PER_GOOD: Partial<Record<GoodId, number>> = {
  xenospice: 10,
  silk: 10,
  plasma: 10,
  antimatter: 5,
  luxury_goods: 25,
  electronics: 25,
  weapons: 25,
  medkits: 25,
};

// MtM cadence — every N ticks. Smaller = more "alive" PnL ticks; larger =
// less computation. 4 keeps it visible without hammering the loop.
export const MTM_INTERVAL_TICKS = 4;

// Tiny per-tick carry agents apply on top of spot when valuing futures.
// Drives a small price differential between near and far contracts. Zero
// is also acceptable — this is a flavour knob, not a fairness one.
export const FUTURES_AGENT_CARRY_BPS = 0.00005;

// Broker fee on open + close, mirrors the spot equity rate.
export const FUTURES_BROKER_FEE_RATE = 0.01;

// --- utilities -----------------------------------------------------------

export function contractIdFor(goodId: GoodId, expiryTick: number): EquityId {
  return `eq_fut_${goodId}_t${expiryTick}`;
}

export function spotEquityIdFor(goodId: GoodId): EquityId {
  return `eq_com_${goodId}`;
}

export function contractSizeFor(goodId: GoodId): number {
  return FUTURES_CONTRACT_SIZE_PER_GOOD[goodId] ?? FUTURES_CONTRACT_SIZE_DEFAULT;
}

export function marginFractionFor(goodId: GoodId): number {
  return FUTURES_MARGIN_FRACTION_PER_GOOD[goodId] ?? FUTURES_MARGIN_FRACTION_DEFAULT;
}

// "Mark price" used for MtM and margin calc. We use the SPOT equity's
// current price (not the futures equity's last trade) so MtM follows the
// underlying without feedback loops on a thinly-traded futures book.
export function markPriceFor(world: World, c: FuturesContract): number {
  const spot = world.equities[c.underlyingEquityId];
  if (!spot) return 0;
  return spot.price;
}

export function marginRequired(world: World, c: FuturesContract, count: number): number {
  return c.marginFraction * c.contractSize * markPriceFor(world, c) * Math.max(0, count);
}

export function notionalFor(world: World, c: FuturesContract, count: number): number {
  return c.contractSize * markPriceFor(world, c) * Math.max(0, count);
}

export function ticksToExpiry(world: World, c: FuturesContract): number {
  return Math.max(0, c.expiryTick - world.tick);
}

// --- listing lifecycle ---------------------------------------------------

export function ensureFuturesContainer(world: World): Record<EquityId, FuturesContract> {
  if (!world.contracts) world.contracts = {};
  return world.contracts;
}

// Create a futures Equity row + matching contract metadata. Anchor +
// initial price = current spot.
function createFuturesPair(
  world: World,
  goodId: GoodId,
  expiryTick: number,
): { equity: Equity; contract: FuturesContract } | null {
  const spotEqId = spotEquityIdFor(goodId);
  const spotEq = world.equities[spotEqId];
  if (!spotEq) return null;
  const id = contractIdFor(goodId, expiryTick);
  if (world.equities[id]) return null;
  const anchor = spotEq.price;
  const ticker = `${(world.goods[goodId]?.name?.match(/[A-Za-z]+/)?.[0] ?? goodId).slice(0, 3).toUpperCase()}${expiryTick % 10000}`.slice(0, 6);
  const equity: Equity = {
    id,
    kind: "futures",
    name: `${world.goods[goodId]?.name ?? goodId} ${expiryTick}`,
    ticker,
    sharesOutstanding: 1_000_000,    // open interest cap; effectively unbounded
    price: anchor,
    anchorPrice: anchor,
    underlyingId: goodId,             // for symmetry with other kinds
    history: [{ tick: world.tick, price: anchor }],
  };
  const contract: FuturesContract = {
    id,
    goodId,
    underlyingEquityId: spotEqId,
    contractSize: contractSizeFor(goodId),
    expiryTick,
    listedAtTick: world.tick,
    marginFraction: marginFractionFor(goodId),
    openInterest: 0,
    clearing: 0,
  };
  world.equities[id] = equity;
  ensureFuturesContainer(world)[id] = contract;
  ensureOrderBook(world, id);
  return { equity, contract };
}

// Run from ensureStockMarket: list near + far contracts for every traded good.
export function ensureFuturesListings(world: World): void {
  const goods = Object.values(world.goods).filter(g => g.category !== "upgrade");
  for (const good of goods) {
    const near = world.tick + NEAR_EXPIRY_TICKS;
    const far = world.tick + FAR_EXPIRY_TICKS;
    createFuturesPair(world, good.id, near);
    createFuturesPair(world, good.id, far);
  }
}

// When the near contract expires, delete it; the prior "far" stays in
// place (its expiryTick is still future), and a new far is listed.
export function rollListings(world: World, goodId: GoodId): void {
  const far = world.tick + FAR_EXPIRY_TICKS;
  createFuturesPair(world, goodId, far);
}

// --- mark-to-market ------------------------------------------------------

// Move (mark - lastMarkPrice) × contractSize × signedContracts of cash
// from short to long (or vice versa). Updates lastMarkPrice on the
// position. Skips if mark hasn't moved.
function applyMtmToPosition(
  world: World,
  c: FuturesContract,
  pos: { contracts: number; lastMarkPrice: number },
  marker: { add: (cash: number) => void },
  newMark: number,
): number {
  const delta = newMark - pos.lastMarkPrice;
  if (delta === 0 || pos.contracts === 0) return 0;
  const cash = delta * c.contractSize * pos.contracts;
  marker.add(cash);
  pos.lastMarkPrice = newMark;
  return cash;
}

function tickContractMtM(world: World, c: FuturesContract): void {
  const newMark = markPriceFor(world, c);
  if (!Number.isFinite(newMark) || newMark <= 0) return;

  // Cash conservation: every cash flow into a position is balanced by an
  // equal-and-opposite flow into the contract's clearing pool. As long
  // as Σ (wallets + funds + clearing) is invariant on every MtM, total
  // system cash stays conserved — even when the player opens against a
  // notional counterparty (clearing absorbs).

  // Player position (single-position-per-contract).
  const player = world.player;
  if (player?.futures?.[c.id]) {
    const fp = player.futures[c.id];
    const sign = fp.side === "long" ? 1 : -1;
    const playerShipId = player.shipIds[0];
    const ship = playerShipId ? world.traders[playerShipId] : null;
    if (ship) {
      applyMtmToPosition(
        world,
        c,
        { contracts: fp.contracts * sign, lastMarkPrice: fp.lastMarkPrice },
        { add: cash => { ship.funds += cash; c.clearing -= cash; } },
        newMark,
      );
      fp.lastMarkPrice = newMark;
    }
  }

  // Agent positions. Don't clamp stockWallet at 0 on MtM losses — that
  // would create money (the long counterparty gets paid full while the
  // short pays only what's in their wallet). Strict accounting: walk the
  // wallet negative on a sufficient loss; bankruptcy mode will pick it up
  // and force a liquidation.
  for (const t of Object.values(world.traders)) {
    const ap = t.stockState?.futuresPositions?.[c.id];
    if (!ap || ap.contracts === 0) continue;
    applyMtmToPosition(
      world,
      c,
      { contracts: ap.contracts, lastMarkPrice: ap.lastMarkPrice },
      { add: cash => {
        if (t.stockState) t.stockState.stockWallet += cash;
        c.clearing -= cash;
      } },
      newMark,
    );
    ap.lastMarkPrice = newMark;
  }
}

// --- settlement ----------------------------------------------------------

function settleContract(world: World, c: FuturesContract): void {
  const spotEq = world.equities[c.underlyingEquityId];
  const spotAtExpiry = spotEq?.price ?? c.clearing;

  // Final MtM at the spot price.
  const player = world.player;
  if (player?.futures?.[c.id]) {
    const fp = player.futures[c.id];
    const sign = fp.side === "long" ? 1 : -1;
    const shipId = player.shipIds[0];
    const ship = shipId ? world.traders[shipId] : null;
    if (ship) {
      // Final MtM cash transfer (balanced by clearing pool).
      const delta = spotAtExpiry - fp.lastMarkPrice;
      const pnl = delta * c.contractSize * fp.contracts * sign;
      ship.funds += pnl;
      c.clearing -= pnl;
      // Refund margin (also balanced — margin came from ship.funds at
      // open and is now returned, but to keep totalSystemCash invariant
      // when reservedFutures was being counted, we don't double-account).
      ship.funds += fp.marginPosted;
    }
    if (player.reservedFutures) delete player.reservedFutures[c.id];
    delete player.futures[c.id];
  }

  for (const t of Object.values(world.traders)) {
    const ap = t.stockState?.futuresPositions?.[c.id];
    if (!ap) continue;
    const delta = spotAtExpiry - ap.lastMarkPrice;
    if (t.stockState) {
      const pnl = delta * c.contractSize * ap.contracts;
      t.stockState.stockWallet += pnl;
      c.clearing -= pnl;
      t.stockState.stockWallet += ap.marginPosted;
      t.stockState.futuresMarginLocked = Math.max(0, (t.stockState.futuresMarginLocked ?? 0) - ap.marginPosted);
      delete t.stockState.futuresPositions![c.id];
    }
  }

  c.settled = { spotAtExpiry, tick: world.tick };
  // Remove the equity row + book + contract. The clearing residue
  // (≤ ε in expectation; possibly larger if many flips happened) is
  // discarded — modelled as exchange operations cost.
  delete world.equities[c.id];
  if (world.orderBooks) delete world.orderBooks[c.id];
  if (world.contracts) delete world.contracts[c.id];

  // Roll a new far contract for this good.
  rollListings(world, c.goodId);
}

// --- per-tick step -------------------------------------------------------

export function tickFutures(world: World): void {
  const contracts = world.contracts;
  if (!contracts) return;
  // MtM at the configured cadence.
  if (world.tick % MTM_INTERVAL_TICKS === 0) {
    for (const c of Object.values(contracts)) tickContractMtM(world, c);
  }
  // Settlement: any contract whose expiry tick has arrived (or passed).
  // Iterate a snapshot since settleContract mutates world.contracts.
  for (const c of Object.values({ ...contracts })) {
    if (world.tick >= c.expiryTick) settleContract(world, c);
  }
}

// --- player API ----------------------------------------------------------

export interface FuturesTradeOk {
  ok: true;
  contracts: number;
  cashFlow: number;
  fee: number;
  marginPosted?: number;
  realizedPnl?: number;
}
export interface FuturesTradeFail { ok: false; reason: string }
export type FuturesTradeResult = FuturesTradeOk | FuturesTradeFail;

function getPlayerShip(world: World, shipId?: TraderId): Trader | null {
  if (!world.player) return null;
  const id = shipId && world.player.shipIds.includes(shipId) ? shipId : world.player.shipIds[0];
  return id ? world.traders[id] ?? null : null;
}

function ensureReservedFutures(world: World): Record<EquityId, number> {
  if (!world.player) return {};
  if (!world.player.reservedFutures) world.player.reservedFutures = {};
  return world.player.reservedFutures;
}

function ensurePlayerFutures(world: World): Record<EquityId, FuturesPosition> {
  if (!world.player) return {};
  if (!world.player.futures) world.player.futures = {};
  return world.player.futures;
}

function openFutureCommon(
  world: World,
  contractId: EquityId,
  count: number,
  side: "long" | "short",
  shipId?: TraderId,
): FuturesTradeResult {
  if (!world.player) return { ok: false, reason: "No player." };
  if (count <= 0 || !Number.isFinite(count)) return { ok: false, reason: "Contract count must be positive." };
  const eq = world.equities[contractId];
  const c = world.contracts?.[contractId];
  if (!eq || !c) return { ok: false, reason: "Contract not listed." };
  if (eq.kind !== "futures") return { ok: false, reason: "Not a futures contract." };
  if (world.tick >= c.expiryTick) return { ok: false, reason: "Contract has expired." };

  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  if (ship.state !== "idle") return { ok: false, reason: "Trade only while docked." };

  // One position per contract — flips not allowed in v1. Reduce/close
  // explicitly through closeFuture.
  const existing = world.player.futures?.[contractId];
  if (existing && existing.side !== side) {
    return { ok: false, reason: `Currently ${existing.side} on ${eq.ticker}. Close before flipping.` };
  }

  const margin = marginRequired(world, c, count);
  const fee = notionalFor(world, c, count) * FUTURES_BROKER_FEE_RATE;
  const total = margin + fee;
  if (ship.funds < total) {
    return { ok: false, reason: `Need Ç${Math.round(total).toLocaleString()} (margin + fee), have Ç${Math.round(ship.funds).toLocaleString()}.` };
  }
  ship.funds -= total;
  const reserved = ensureReservedFutures(world);
  reserved[contractId] = (reserved[contractId] ?? 0) + margin;

  const positions = ensurePlayerFutures(world);
  const mark = markPriceFor(world, c);
  const cur = positions[contractId];
  if (cur) {
    // Synthetic MtM the existing leg from lastMark → mark before adding,
    // so the combined position carries one consistent lastMark = mark.
    const sign = cur.side === "long" ? 1 : -1;
    const syntheticDelta = mark - cur.lastMarkPrice;
    if (syntheticDelta !== 0) {
      const cash = syntheticDelta * c.contractSize * cur.contracts * sign;
      ship.funds += cash;
      c.clearing -= cash;
    }
    // Add to existing position; weighted-average entry price.
    const totalContracts = cur.contracts + count;
    cur.avgEntryPrice = (cur.avgEntryPrice * cur.contracts + mark * count) / totalContracts;
    cur.contracts = totalContracts;
    cur.marginPosted += margin;
    cur.lastMarkPrice = mark;
  } else {
    positions[contractId] = {
      contractId,
      side,
      contracts: count,
      avgEntryPrice: mark,
      marginPosted: margin,
      openedAt: world.tick,
      lastMarkPrice: mark,
    };
  }
  c.openInterest += count;
  return { ok: true, contracts: count, cashFlow: -total, fee, marginPosted: margin };
}

export function openLongFuture(world: World, contractId: EquityId, count: number, shipId?: TraderId): FuturesTradeResult {
  return openFutureCommon(world, contractId, count, "long", shipId);
}

export function openShortFuture(world: World, contractId: EquityId, count: number, shipId?: TraderId): FuturesTradeResult {
  return openFutureCommon(world, contractId, count, "short", shipId);
}

// Close (or partially close) a futures position. Realized PnL = MtM at
// current mark. Margin proportional to closed contracts is refunded.
export function closeFuture(world: World, contractId: EquityId, count?: number, shipId?: TraderId): FuturesTradeResult {
  if (!world.player) return { ok: false, reason: "No player." };
  const eq = world.equities[contractId];
  const c = world.contracts?.[contractId];
  if (!eq || !c) return { ok: false, reason: "Contract not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  if (ship.state !== "idle") return { ok: false, reason: "Trade only while docked." };
  const fp = world.player.futures?.[contractId];
  if (!fp) return { ok: false, reason: "No open position." };
  const closing = count == null ? fp.contracts : Math.min(fp.contracts, Math.max(0, count));
  if (closing <= 0) return { ok: false, reason: "Nothing to close." };

  const mark = markPriceFor(world, c);
  const sign = fp.side === "long" ? 1 : -1;
  // Realized at close: from lastMarkPrice → mark (the MtM-uncommitted
  // delta). The avgEntryPrice → lastMarkPrice slice has already moved
  // through variation margin; realizing from avgEntryPrice would double
  // the lifetime PnL.
  const realizedPnl = (mark - fp.lastMarkPrice) * c.contractSize * closing * sign;
  const marginRefund = fp.marginPosted * (closing / fp.contracts);
  const fee = c.contractSize * mark * closing * FUTURES_BROKER_FEE_RATE;
  ship.funds += marginRefund + realizedPnl - fee;
  c.clearing -= realizedPnl;

  // Update or delete position.
  fp.contracts -= closing;
  fp.marginPosted -= marginRefund;
  c.openInterest = Math.max(0, c.openInterest - closing);
  const reserved = ensureReservedFutures(world);
  reserved[contractId] = Math.max(0, (reserved[contractId] ?? 0) - marginRefund);
  if (fp.contracts <= 0.0001) {
    delete world.player.futures![contractId];
    delete reserved[contractId];
  }
  return { ok: true, contracts: closing, cashFlow: marginRefund + realizedPnl - fee, fee, realizedPnl };
}

// --- queries -------------------------------------------------------------

export function listOpenContracts(world: World, goodId?: GoodId): FuturesContract[] {
  const all = Object.values(world.contracts ?? {});
  return goodId ? all.filter(c => c.goodId === goodId) : all;
}

export function listPlayerFutures(world: World): FuturesPosition[] {
  return Object.values(world.player?.futures ?? {});
}

export function unrealizedFuturesPnl(world: World, fp: FuturesPosition): number {
  const c = world.contracts?.[fp.contractId];
  if (!c) return 0;
  const mark = markPriceFor(world, c);
  const sign = fp.side === "long" ? 1 : -1;
  return (mark - fp.avgEntryPrice) * c.contractSize * fp.contracts * sign;
}

// --- agent-side fill handling --------------------------------------------
// Called from the integration layer when a futures equity prints a trade
// where one (or both) sides is an agent. Manages stockWallet margin debit
// and AgentFuturesPosition bookkeeping. Returns true if handled (caller
// can short-circuit further share-position handling).

export function applyAgentFuturesFill(
  world: World,
  trader: Trader,
  contractId: EquityId,
  signedContracts: number,
  fillPrice: number,
): void {
  const c = world.contracts?.[contractId];
  if (!c || !trader.stockState) return;
  const state = trader.stockState;
  if (!state.futuresPositions) state.futuresPositions = {};
  const cur = state.futuresPositions[contractId];

  const sizePerContract = c.contractSize;
  const incomingSign = signedContracts > 0 ? 1 : -1;

  if (!cur || cur.contracts === 0) {
    // Open a fresh position. lastMark = fillPrice (zero unrealized PnL
    // at open).
    const margin = c.marginFraction * sizePerContract * fillPrice * Math.abs(signedContracts);
    state.stockWallet -= margin;
    state.futuresMarginLocked = (state.futuresMarginLocked ?? 0) + margin;
    state.futuresPositions[contractId] = {
      contracts: signedContracts,
      avgEntryPrice: fillPrice,
      marginPosted: margin,
      openedAt: world.tick,
      lastMarkPrice: fillPrice,
    };
    c.openInterest += Math.abs(signedContracts);
    return;
  }

  // Existing position. Apply a synthetic MtM from cur.lastMarkPrice →
  // fillPrice for ALL existing contracts before mutating the position.
  // This realizes any in-flight PnL on the OLD contracts so the new
  // contracts (and any reduced position) start from a clean lastMark =
  // fillPrice. Without this, adding to a same-sign position would skew
  // the next MtM tick's delta and create / destroy money.
  const syntheticDelta = fillPrice - cur.lastMarkPrice;
  if (syntheticDelta !== 0) {
    const synthetic = syntheticDelta * sizePerContract * cur.contracts;
    state.stockWallet += synthetic;
    c.clearing -= synthetic;
    cur.lastMarkPrice = fillPrice;
  }

  const curSign = cur.contracts > 0 ? 1 : -1;
  const newContracts = cur.contracts + signedContracts;

  if (curSign === incomingSign) {
    // Adding more in the same direction. Synthetic MtM already ran;
    // just lock additional margin and update count + avg entry.
    const margin = c.marginFraction * sizePerContract * fillPrice * Math.abs(signedContracts);
    state.stockWallet -= margin;
    state.futuresMarginLocked = (state.futuresMarginLocked ?? 0) + margin;
    cur.avgEntryPrice = (cur.avgEntryPrice * Math.abs(cur.contracts) + fillPrice * Math.abs(signedContracts))
                     / (Math.abs(cur.contracts) + Math.abs(signedContracts));
    cur.contracts = newContracts;
    cur.marginPosted += margin;
    c.openInterest += Math.abs(signedContracts);
    return;
  }

  // Reducing / flipping. Synthetic MtM already realized the in-flight
  // PnL up to fillPrice; closing contracts at fillPrice now realizes
  // exactly zero further PnL (margin refund only).
  const closingMagnitude = Math.min(Math.abs(cur.contracts), Math.abs(signedContracts));
  const marginRefund = cur.marginPosted * (closingMagnitude / Math.abs(cur.contracts));
  state.stockWallet += marginRefund;
  state.futuresMarginLocked = Math.max(0, (state.futuresMarginLocked ?? 0) - marginRefund);
  cur.contracts = newContracts;
  cur.marginPosted -= marginRefund;
  c.openInterest = Math.max(0, c.openInterest - closingMagnitude);

  if (Math.abs(newContracts) < 0.0001) {
    delete state.futuresPositions[contractId];
    return;
  }
  if (curSign !== (newContracts > 0 ? 1 : -1)) {
    // Flip — open a fresh leg in the new direction with the residual.
    const overhang = Math.abs(signedContracts) - closingMagnitude;
    const margin = c.marginFraction * sizePerContract * fillPrice * overhang;
    state.stockWallet -= margin;
    state.futuresMarginLocked = (state.futuresMarginLocked ?? 0) + margin;
    cur.avgEntryPrice = fillPrice;
    cur.openedAt = world.tick;
    cur.marginPosted = margin;
    c.openInterest += overhang;
  }
  cur.lastMarkPrice = fillPrice;
}

// Convenience predicate.
export function isFuturesEquity(world: World, equityId: EquityId): boolean {
  return world.equities[equityId]?.kind === "futures";
}
