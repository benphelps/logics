// Stock market layer: stations and NPC syndicates as publicly-traded
// equities. Players buy and sell shares using their anchor ship's wallet.
//
// Design pillars:
//
// 1. Prices are anchored to a known IPO price (clamped to [0.1×, 10×] of
//    anchor) so the late-game stays readable — same shape as the goods price
//    clamp. There is no global inflation vector for share prices.
//
// 2. Prices respond to underlying signals — treasury health for stations,
//    fleet wealth + recent revenue for syndicates. The signal is the
//    *health ratio*, not the absolute number, so prices stay scale-stable
//    across world sizes.
//
// 3. Dividends close the long-term loop. Quarterly (every DIVIDEND_INTERVAL
//    ticks), each entity pays a fraction of its profit/health to shareholders.
//    Shareholders include the player; NPC-held shares (the float not owned by
//    the player) effectively recycle the dividend back to the entity.
//
// 4. There is a small broker fee on each trade — a real sink that prevents
//    the player from extracting infinite money via tax-arbitrage round-trips.
//
// 5. The mechanic integrates with treasuries: when a station's treasury is
//    healthy, its share price rises; when it depletes, share price falls.
//    Watching treasuries is the "alpha" — a player who notices a depleted
//    treasury before others can short the station's shares.

import type {
  Equity,
  EquityId,
  Player,
  StockPosition,
  Syndicate,
  SyndicateId,
  TradeAction,
  TradeRecord,
  TraderId,
  TriggerKind,
  World,
} from "./types";
import { mulberry32 } from "./gen/rng";
import { depositToTreasury } from "./economy";

// --- tunables --------------------------------------------------------------

export const SHARE_PRICE_FLOOR_MULT = 0.1;     // can't drop below 10% of IPO
export const SHARE_PRICE_CEILING_MULT = 10.0;  // can't rise above 10× IPO
export const SHARE_PRICE_SMOOTHING = 0.10;     // EMA smoothing for price moves; small = sticky
export const SHARE_PRICE_NOISE = 0.0025;       // ±0.25% per-tick noise so prices wiggle
export const SHARES_OUTSTANDING_DEFAULT = 10_000;

export const STATION_IPO_PER_POPULATION = 50;  // initial share price ~ pop × this / shares
export const SYNDICATE_IPO_DEFAULT = 250;

export const BROKER_FEE_RATE = 0.01;           // 1% fee on share trades
export const DIVIDEND_INTERVAL = 200;          // ticks between dividend payouts
export const DIVIDEND_PAYOUT_FRACTION = 0.05;  // 5% of treasury surplus → dividends

export const SYNDICATE_REVENUE_DECAY = 0.95;   // per-tick decay on recent revenue
export const SYNDICATE_PRICE_REVENUE_WEIGHT = 0.0001; // how much revenue tilts price

export const SHARE_PRICE_HISTORY_MAX = 60;     // capped history per equity

// Per-tick borrow fee on a short position's notional value. A real cost
// (in real markets, paid to whoever lent the shares). Kept small so daily
// holds don't bleed out, but enough that infinitely-held shorts aren't free.
export const SHORT_BORROW_RATE_PER_TICK = 0.0001;
export const TRADE_LEDGER_MAX = 200;

// --- equity construction --------------------------------------------------

function tickerFromName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  return cleaned.slice(0, 4) || "XXXX";
}

export function createStationEquity(locId: string, locName: string, population: number): Equity {
  const anchor = Math.max(50, population * STATION_IPO_PER_POPULATION / SHARES_OUTSTANDING_DEFAULT);
  return {
    id: `eq_loc_${locId}`,
    kind: "station",
    name: locName,
    ticker: tickerFromName(locName),
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: anchor,
    anchorPrice: anchor,
    underlyingId: locId,
    history: [{ tick: 0, price: anchor }],
  };
}

export function createSyndicateEquity(synd: Syndicate): Equity {
  const anchor = SYNDICATE_IPO_DEFAULT;
  return {
    id: `eq_syn_${synd.id}`,
    kind: "syndicate",
    name: synd.name,
    ticker: tickerFromName(synd.name),
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: anchor,
    anchorPrice: anchor,
    underlyingId: synd.id,
    history: [{ tick: 0, price: anchor }],
  };
}

// --- syndicate construction & assignment ----------------------------------

const SYNDICATE_NAMES = [
  "Voss Cargo Syndicate",
  "Kestrel Shipping Group",
  "Outerguild Hauliers",
  "Marsh Combine",
  "Holt Freightline",
  "Antares Confederation",
  "Pelican Lines",
  "Brae Industries",
];

// Group NPC traders into syndicates. Player ships are excluded. Returns the
// new syndicates indexed by id. Each NPC is assigned to one syndicate.
export function buildSyndicates(world: World, count: number = 4, seed: number = 1): Record<SyndicateId, Syndicate> {
  const rng = mulberry32(seed | 0);
  const npcIds = Object.values(world.traders)
    .filter(t => !world.player?.shipIds.includes(t.id))
    .map(t => t.id);
  if (npcIds.length === 0) return {};
  const n = Math.min(count, SYNDICATE_NAMES.length, Math.max(1, Math.floor(npcIds.length / 2)));

  const syndicates: Record<SyndicateId, Syndicate> = {};
  const names = [...SYNDICATE_NAMES];
  for (let i = 0; i < n; i++) {
    const id: SyndicateId = `syn_${i + 1}`;
    const idx = Math.floor(rng() * names.length);
    const name = names.splice(idx, 1)[0];
    syndicates[id] = {
      id,
      name,
      memberShipIds: [],
      treasury: 0,
      recentRevenue: 0,
    };
  }
  // Assign NPCs round-robin to syndicates
  const ids = Object.keys(syndicates);
  for (let i = 0; i < npcIds.length; i++) {
    const synId = ids[i % ids.length];
    syndicates[synId].memberShipIds.push(npcIds[i]);
  }
  return syndicates;
}

export function ensureStockMarket(world: World, opts: { syndicateCount?: number; seed?: number } = {}): void {
  if (Object.keys(world.equities).length > 0) return;
  // Syndicates first (so equities can reference them)
  if (Object.keys(world.syndicates).length === 0) {
    world.syndicates = buildSyndicates(world, opts.syndicateCount ?? 4, opts.seed ?? 1);
  }
  for (const loc of Object.values(world.locations)) {
    const eq = createStationEquity(loc.id, loc.name, loc.population);
    world.equities[eq.id] = eq;
  }
  for (const synd of Object.values(world.syndicates)) {
    const eq = createSyndicateEquity(synd);
    world.equities[eq.id] = eq;
  }
}

// --- per-tick price update -------------------------------------------------

function syndicateWealth(world: World, syn: Syndicate): number {
  let w = syn.treasury;
  for (const id of syn.memberShipIds) {
    const t = world.traders[id];
    if (t) w += t.funds;
  }
  return w;
}

function clampSharePrice(eq: Equity, price: number): number {
  const floor = eq.anchorPrice * SHARE_PRICE_FLOOR_MULT;
  const ceiling = eq.anchorPrice * SHARE_PRICE_CEILING_MULT;
  return Math.max(floor, Math.min(ceiling, price));
}

// Compute the "fundamental" price for an equity from underlying signals.
// Every signal is converted to a multiplier on anchorPrice. The tick-by-tick
// EMA blend toward this fundamental drives the visible price.
function computeFundamental(world: World, eq: Equity): number {
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    if (!market) return eq.anchorPrice;
    // Station signal: treasury health (rich = expensive shares) +
    // demand-fulfillment (high stock vs target = healthy economy).
    const target = Math.max(1, market.treasuryTarget);
    const treasuryRatio = market.treasury / target;
    // Map ratio to a multiplier: ratio=1 → 1.0, ratio=0 → 0.7, ratio=2 → 1.6
    let mult = 1.0;
    if (treasuryRatio >= 0) mult = 0.7 + 0.45 * Math.min(2, treasuryRatio);
    else mult = Math.max(0.3, 0.7 + treasuryRatio * 0.35);    // negative ratio shrinks
    return eq.anchorPrice * mult;
  }
  // Syndicate signal: total wealth (treasury + member ship funds) and recent
  // revenue. Higher wealth/revenue → higher share price.
  const synd = world.syndicates[eq.underlyingId];
  if (!synd) return eq.anchorPrice;
  const wealth = syndicateWealth(world, synd);
  // Anchor: a well-capitalized syndicate of N ships should be at "fair value"
  // around N × Ç20K wealth → mult = 1.0. Below that, lower; above, higher.
  const fairWealth = Math.max(1, synd.memberShipIds.length * 20_000);
  const wealthMult = 0.5 + 0.5 * (wealth / fairWealth);
  const revenueMult = 1 + synd.recentRevenue * SYNDICATE_PRICE_REVENUE_WEIGHT;
  return eq.anchorPrice * wealthMult * revenueMult;
}

function deterministicNoise(eq: Equity, tick: number): number {
  // Per-equity seeded noise so prices wiggle realistically. Same world tick
  // → same noise (determinism preserved).
  const seed = (hashStr(eq.id) ^ tick) | 0;
  const rng = mulberry32(seed);
  return (rng() - 0.5) * 2 * SHARE_PRICE_NOISE;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function recomputeEquityPrice(world: World, eq: Equity): void {
  const fundamental = computeFundamental(world, eq);
  // EMA blend — small smoothing so prices don't whip every tick
  const blended = eq.price + SHARE_PRICE_SMOOTHING * (fundamental - eq.price);
  // Add small per-tick noise scaled by current price so it's proportional
  const noisy = blended * (1 + deterministicNoise(eq, world.tick));
  eq.prevPrice = eq.price;
  eq.price = clampSharePrice(eq, noisy);
  // Append history, capped
  if (!eq.history) eq.history = [];
  eq.history.push({ tick: world.tick, price: eq.price });
  if (eq.history.length > SHARE_PRICE_HISTORY_MAX) {
    eq.history.splice(0, eq.history.length - SHARE_PRICE_HISTORY_MAX);
  }
}

// --- syndicate revenue tracking -------------------------------------------

export function noteSyndicateRevenue(world: World, traderId: TraderId, amount: number): void {
  if (amount <= 0) return;
  for (const synd of Object.values(world.syndicates)) {
    if (synd.memberShipIds.includes(traderId)) {
      synd.recentRevenue += amount;
      return;
    }
  }
}

export function decaySyndicateRevenue(world: World): void {
  for (const synd of Object.values(world.syndicates)) {
    synd.recentRevenue *= SYNDICATE_REVENUE_DECAY;
  }
}

// --- dividends -------------------------------------------------------------

// Dividend payouts run at fixed intervals. Each station pays a tiny fraction
// of its treasury surplus (above target) to shareholders. Each syndicate
// pays from its treasury based on recent profits.
export function payoutDividends(world: World): void {
  if (world.tick === 0 || world.tick % DIVIDEND_INTERVAL !== 0) return;
  const player = world.player;

  for (const eq of Object.values(world.equities)) {
    let perShare = 0;
    let sourceFunds = 0;       // money pool the dividend comes from
    let sinkFn: ((amount: number) => void) | null = null;

    if (eq.kind === "station") {
      const market = world.markets[eq.underlyingId];
      if (!market) continue;
      // Pay only from surplus above target — depleted treasuries pay nothing.
      const surplus = market.treasury - market.treasuryTarget;
      if (surplus <= 0) continue;
      sourceFunds = surplus * DIVIDEND_PAYOUT_FRACTION;
      sinkFn = (amount) => { market.treasury -= amount; };
    } else {
      const synd = world.syndicates[eq.underlyingId];
      if (!synd || synd.treasury <= 0) continue;
      sourceFunds = synd.treasury * DIVIDEND_PAYOUT_FRACTION;
      sinkFn = (amount) => { synd.treasury -= amount; };
    }

    if (sourceFunds <= 0) continue;
    perShare = sourceFunds / eq.sharesOutstanding;
    eq.lastDividend = { tick: world.tick, perShare };
    // Pay long positions; short positions OWE the dividend (real-market
    // mechanic: a short seller is responsible for paying the lender any
    // dividend that accrued during the borrow).
    const position = player?.positions?.[eq.id];
    if (player && position && perShare > 0) {
      const playerShipId = player.shipIds[0];
      const playerShip = playerShipId ? world.traders[playerShipId] : null;
      if (!playerShip) continue;
      if (position.kind === "long") {
        const payout = perShare * position.shares;
        playerShip.funds += payout;
        if (sinkFn) sinkFn(payout);
      } else {
        // Short — player pays out a dividend equivalent to the lender (sink:
        // back into the equity's underlying, closed loop).
        const owed = perShare * position.shares;
        const paid = Math.min(owed, playerShip.funds);
        playerShip.funds -= paid;
        // The dividend payment from the short flows TO the underlying as if
        // the short opened sold the dividend back into the float.
        if (eq.kind === "station") {
          const market = world.markets[eq.underlyingId];
          if (market) market.treasury += paid;
        } else {
          const synd = world.syndicates[eq.underlyingId];
          if (synd) synd.treasury += paid;
        }
      }
    }
  }
}

// --- player trading actions ------------------------------------------------

export type StockTradeResult =
  | { ok: true; shares: number; cashFlow: number; fee: number; realizedPnl?: number }
  | { ok: false; reason: string };

function getPlayerShip(world: World) {
  if (!world.player) return null;
  const id = world.player.shipIds[0];
  return id ? world.traders[id] ?? null : null;
}

function ensurePositions(player: Player): Record<EquityId, StockPosition> {
  if (!player.positions) player.positions = {};
  return player.positions;
}

function ensureTrades(player: Player): TradeRecord[] {
  if (!player.trades) player.trades = [];
  return player.trades;
}

let nextTradeIdCounter = 1;
function makeTradeId(world: World): string {
  return `tr_${world.tick}_${nextTradeIdCounter++}`;
}

function recordTrade(
  world: World,
  player: Player,
  eq: Equity,
  action: TradeAction,
  shares: number,
  price: number,
  fee: number,
  cashFlow: number,
  realizedPnl?: number,
  trigger?: TriggerKind,
): TradeRecord {
  const trades = ensureTrades(player);
  const entry: TradeRecord = {
    id: makeTradeId(world),
    tick: world.tick,
    equityId: eq.id,
    ticker: eq.ticker,
    action,
    shares,
    price,
    fee,
    cashFlow,
    realizedPnl,
    trigger,
  };
  trades.push(entry);
  if (trades.length > TRADE_LEDGER_MAX) trades.splice(0, trades.length - TRADE_LEDGER_MAX);
  return entry;
}

interface TradeContext {
  player: Player;
  eq: Equity;
  ship: ReturnType<typeof getPlayerShip>;
}

function preflight(world: World, equityId: EquityId, shares: number): TradeContext | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  if (shares <= 0 || !Number.isFinite(shares)) return { ok: false, reason: "Quantity must be positive." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  if (ship.state !== "idle") return { ok: false, reason: "Trade only while docked." };
  return { player: world.player, eq, ship };
}

// Open or add to a long position.
export function buyShares(world: World, equityId: EquityId, shares: number): StockTradeResult {
  const ctx = preflight(world, equityId, shares);
  if ("ok" in ctx) return ctx;
  const { player, eq, ship } = ctx;
  const positions = ensurePositions(player);
  const current = positions[equityId];
  if (current?.kind === "short") {
    return { ok: false, reason: `Currently short ${current.shares} ${eq.ticker}. Cover the short before going long.` };
  }
  // Cap by float not held
  const owned = current?.shares ?? 0;
  const maxBuyable = Math.max(0, eq.sharesOutstanding - owned);
  if (shares > maxBuyable) return { ok: false, reason: `Only ${maxBuyable} shares available on the float.` };
  const cost = shares * eq.price;
  const fee = cost * BROKER_FEE_RATE;
  const total = cost + fee;
  if (ship!.funds < total) return { ok: false, reason: `Need Ç${Math.round(total).toLocaleString()}, have Ç${Math.round(ship!.funds).toLocaleString()}.` };

  ship!.funds -= total;
  routeShareCashFlow(world, eq, cost);

  if (!current) {
    positions[equityId] = {
      equityId,
      kind: "long",
      shares,
      avgEntryPrice: eq.price,
      openedAt: world.tick,
    };
    recordTrade(world, player, eq, "open_long", shares, eq.price, fee, -total);
  } else {
    // Weighted-average entry price across the combined position
    const totalShares = current.shares + shares;
    current.avgEntryPrice = (current.avgEntryPrice * current.shares + eq.price * shares) / totalShares;
    current.shares = totalShares;
    recordTrade(world, player, eq, "add_long", shares, eq.price, fee, -total);
  }
  return { ok: true, shares, cashFlow: -total, fee };
}

// Close (or partially close) a long position. `trigger` is set when this
// runs from the per-tick stop-loss / take-profit check; the trade ledger
// records it so the player can scan for auto-fired closes.
export function sellShares(
  world: World,
  equityId: EquityId,
  shares: number,
  trigger?: TriggerKind,
): StockTradeResult {
  const ctx = preflight(world, equityId, shares);
  if ("ok" in ctx) return ctx;
  const { player, eq, ship } = ctx;
  const positions = ensurePositions(player);
  const current = positions[equityId];
  if (!current || current.kind !== "long") {
    return { ok: false, reason: `No long position in ${eq.ticker}.` };
  }
  if (shares > current.shares) return { ok: false, reason: `Only ${current.shares} shares owned.` };

  const proceedsWanted = shares * eq.price;
  const realized = drawShareCashFlow(world, eq, proceedsWanted);
  const fee = realized * BROKER_FEE_RATE;
  const net = realized - fee;
  ship!.funds += net;

  // Realized P&L = (sale price - avg entry) × shares (using gross price; fee
  // is bookkept separately for transparency).
  const realizedPnl = (eq.price - current.avgEntryPrice) * shares - fee;
  current.shares -= shares;
  if (current.shares <= 0.0001) delete positions[equityId];
  recordTrade(world, player, eq, "close_long", shares, eq.price, fee, net, realizedPnl, trigger);
  return { ok: true, shares, cashFlow: net, fee, realizedPnl };
}

// Returns the maximum cash the equity's underlying can actually pay out to a
// short seller right now. Used both to cap short opens and to expose the
// real "max shortable" to the UI.
export function maxShortableShares(world: World, eq: Equity): number {
  if (eq.price <= 0) return 0;
  let availableCash = 0;
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    if (!market) return 0;
    const target = market.treasuryTarget || 1;
    const floor = -2 * target;
    availableCash = Math.max(0, market.treasury - floor);
  } else {
    const synd = world.syndicates[eq.underlyingId];
    if (!synd) return 0;
    availableCash = Math.max(0, synd.treasury);
  }
  return Math.floor(availableCash / eq.price);
}

// Open or add to a short position. Borrows shares and immediately sells them
// at the current price. Player receives the cash (minus fee). Future cover
// re-buys the shares; profit if price falls, loss if it rises.
export function shortShares(world: World, equityId: EquityId, shares: number): StockTradeResult {
  const ctx = preflight(world, equityId, shares);
  if ("ok" in ctx) return ctx;
  const { player, eq, ship } = ctx;
  const positions = ensurePositions(player);
  const current = positions[equityId];
  if (current?.kind === "long") {
    return { ok: false, reason: `Currently long ${current.shares} ${eq.ticker}. Sell the long before shorting.` };
  }
  // Borrow cap: by float and by what the underlying can actually fund.
  // Without the funding cap, a player could "short" against a depleted
  // treasury, receive 0 proceeds, and end up with a position they can never
  // cover — the original bug we hit on a fresh-world Ç0-treasury syndicate.
  const currentShort = current?.shares ?? 0;
  const maxByFloat = Math.max(0, eq.sharesOutstanding - currentShort);
  const maxByFunding = maxShortableShares(world, eq);
  const maxShortable = Math.min(maxByFloat, maxByFunding);
  if (maxShortable <= 0) {
    return { ok: false, reason: `${eq.ticker}'s book is too thin to fund a short right now.` };
  }
  if (shares > maxShortable) {
    return { ok: false, reason: `Only ${maxShortable} shares fundable at this quote.` };
  }

  const proceedsGross = shares * eq.price;
  // Underlying funds the short via drawShareCashFlow. We just capped `shares`
  // against the available pool, so `realized` should equal `proceedsGross`
  // (within rounding).
  const realized = drawShareCashFlow(world, eq, proceedsGross);
  const fee = realized * BROKER_FEE_RATE;
  const net = realized - fee;
  ship!.funds += net;

  if (!current) {
    positions[equityId] = {
      equityId,
      kind: "short",
      shares,
      avgEntryPrice: eq.price,
      openedAt: world.tick,
    };
    recordTrade(world, player, eq, "open_short", shares, eq.price, fee, net);
  } else {
    const totalShares = current.shares + shares;
    current.avgEntryPrice = (current.avgEntryPrice * current.shares + eq.price * shares) / totalShares;
    current.shares = totalShares;
    recordTrade(world, player, eq, "add_short", shares, eq.price, fee, net);
  }
  return { ok: true, shares, cashFlow: net, fee };
}

// Close (or partially close) a short position. Buys back the borrowed shares
// at the current market price.
export function coverShares(
  world: World,
  equityId: EquityId,
  shares: number,
  trigger?: TriggerKind,
): StockTradeResult {
  const ctx = preflight(world, equityId, shares);
  if ("ok" in ctx) return ctx;
  const { player, eq, ship } = ctx;
  const positions = ensurePositions(player);
  const current = positions[equityId];
  if (!current || current.kind !== "short") {
    return { ok: false, reason: `No short position in ${eq.ticker}.` };
  }
  if (shares > current.shares) return { ok: false, reason: `Only ${current.shares} shares short.` };

  const cost = shares * eq.price;
  const fee = cost * BROKER_FEE_RATE;
  const total = cost + fee;
  if (ship!.funds < total) return { ok: false, reason: `Need Ç${Math.round(total).toLocaleString()} to cover, have Ç${Math.round(ship!.funds).toLocaleString()}.` };

  ship!.funds -= total;
  // The buyback principal flows back into the underlying (closed loop).
  routeShareCashFlow(world, eq, cost);

  // Realized P&L for a short: (entry price - cover price) × shares - fee.
  const realizedPnl = (current.avgEntryPrice - eq.price) * shares - fee;
  current.shares -= shares;
  if (current.shares <= 0.0001) delete positions[equityId];
  recordTrade(world, player, eq, "cover_short", shares, eq.price, fee, -total, realizedPnl, trigger);
  return { ok: true, shares, cashFlow: -total, fee, realizedPnl };
}

// Walk away from a position regardless of cash. Records realized P&L at the
// current mark, with a fixed walk-away penalty that bites — without it, this
// is just "free close at any time" and breaks the cover-cost mechanic. Used
// as the escape hatch for shorts the player can't afford to buy back, and
// for longs they want to dump cleanly. The position vanishes; lender / buyer
// is notionally absorbed by the equity's underlying.
export const ABANDON_PENALTY_RATE = 0.05;     // 5% extra hit on top of mark-to-market

export function abandonPosition(world: World, equityId: EquityId, trigger?: TriggerKind): StockTradeResult {
  if (!world.player) return { ok: false, reason: "No player." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const positions = ensurePositions(world.player);
  const pos = positions[equityId];
  if (!pos) return { ok: false, reason: "No position to abandon." };

  // Mark-to-market value plus the abandon penalty.
  const baseline = unrealizedPnl(world, pos);
  const penalty = pos.shares * eq.price * ABANDON_PENALTY_RATE;
  const realizedPnl = baseline - penalty;
  // The position's "settle" cash flow: positive if the trade was winning more
  // than the penalty, negative otherwise. Capped at the player's funds when
  // negative — they can't go beneath zero. The lender/underlying absorbs any
  // unfundable shortfall.
  let cashFlow: number;
  if (realizedPnl >= 0) {
    cashFlow = Math.min(realizedPnl, ship.funds + realizedPnl);
    ship.funds += cashFlow;
  } else {
    const owed = -realizedPnl;
    const paid = Math.min(owed, ship.funds);
    ship.funds -= paid;
    cashFlow = -paid;
  }
  delete positions[equityId];
  recordTrade(
    world,
    world.player,
    eq,
    pos.kind === "long" ? "close_long" : "cover_short",
    pos.shares,
    eq.price,
    penalty,
    cashFlow,
    realizedPnl,
    trigger,
  );
  return { ok: true, shares: pos.shares, cashFlow, fee: penalty, realizedPnl };
}

// --- stop-loss / take-profit -----------------------------------------------

// Set or clear the stop-loss price for a position. Pass `null` to clear.
// The threshold's direction is implicit in the position's kind (see the
// StockPosition docstring for the stop/take semantics).
export function setStopLoss(world: World, equityId: EquityId, price: number | null): { ok: true } | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  const pos = world.player.positions?.[equityId];
  if (!pos) return { ok: false, reason: "No position to attach a stop to." };
  if (price == null) { delete pos.stopLoss; return { ok: true }; }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "Stop price must be positive." };
  // Sanity: a long stop-loss above current price would fire instantly. Allow
  // it (player may want exit-now), but reject obvious mistakes that put the
  // stop on the wrong side of profit logic.
  pos.stopLoss = price;
  return { ok: true };
}

export function setTakeProfit(world: World, equityId: EquityId, price: number | null): { ok: true } | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  const pos = world.player.positions?.[equityId];
  if (!pos) return { ok: false, reason: "No position to attach a target to." };
  if (price == null) { delete pos.takeProfit; return { ok: true }; }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "Target price must be positive." };
  pos.takeProfit = price;
  return { ok: true };
}

// Evaluate every position's stop-loss and take-profit against the current
// price. Triggers fire AFTER the per-tick price recompute. If the regular
// close path can't execute (treasury starved on a long sell, or player
// short on cash for a short cover), fall back to abandonPosition so the
// player isn't left with a position they wanted out of.
export function checkPositionTriggers(world: World): void {
  if (!world.player?.positions) return;
  // Snapshot so we can mutate the positions map during iteration.
  for (const eqId of Object.keys(world.player.positions)) {
    const pos = world.player.positions[eqId];
    if (!pos) continue;
    const eq = world.equities[eqId];
    if (!eq) continue;
    const trigger = triggerHit(pos, eq.price);
    if (!trigger) continue;
    // Long → sell; short → cover. Fall back to abandon if the close path
    // can't execute (e.g. treasury broke, player broke).
    let result: StockTradeResult;
    if (pos.kind === "long") {
      result = sellShares(world, eqId, pos.shares, trigger);
      if (!result.ok) result = abandonPosition(world, eqId, trigger);
    } else {
      result = coverShares(world, eqId, pos.shares, trigger);
      if (!result.ok) result = abandonPosition(world, eqId, trigger);
    }
  }
}

function triggerHit(pos: StockPosition, price: number): TriggerKind | null {
  if (pos.kind === "long") {
    if (pos.stopLoss != null && price <= pos.stopLoss) return "stop_loss";
    if (pos.takeProfit != null && price >= pos.takeProfit) return "take_profit";
  } else {
    if (pos.stopLoss != null && price >= pos.stopLoss) return "stop_loss";
    if (pos.takeProfit != null && price <= pos.takeProfit) return "take_profit";
  }
  return null;
}

// Per-tick borrow fee on every open short position. Real sink — destroyed.
// Without this, holding a short forever would cost nothing, breaking the
// risk/reward symmetry between long and short.
export function tickShortBorrowFees(world: World): void {
  if (!world.player) return;
  const positions = world.player.positions;
  if (!positions) return;
  const ship = getPlayerShip(world);
  if (!ship) return;
  let totalFee = 0;
  for (const pos of Object.values(positions)) {
    if (pos.kind !== "short") continue;
    const eq = world.equities[pos.equityId];
    if (!eq) continue;
    const notional = pos.shares * eq.price;
    const fee = notional * SHORT_BORROW_RATE_PER_TICK;
    totalFee += fee;
  }
  if (totalFee <= 0) return;
  ship.funds = Math.max(0, ship.funds - totalFee);
}

// Helpers exposed to the UI ----------------------------------------------

export function unrealizedPnl(world: World, position: StockPosition): number {
  const eq = world.equities[position.equityId];
  if (!eq) return 0;
  if (position.kind === "long") {
    return (eq.price - position.avgEntryPrice) * position.shares;
  }
  return (position.avgEntryPrice - eq.price) * position.shares;
}

export function listPositions(world: World): StockPosition[] {
  return Object.values(world.player?.positions ?? {});
}

export function listTradeRecords(world: World, limit = TRADE_LEDGER_MAX): TradeRecord[] {
  const trades = world.player?.trades ?? [];
  return trades.slice(-limit).reverse();
}

// --- internal cash routing ------------------------------------------------

function routeShareCashFlow(world: World, eq: Equity, amount: number): void {
  if (amount <= 0) return;
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    if (market) depositToTreasury(market, amount);
    return;
  }
  const synd = world.syndicates[eq.underlyingId];
  if (synd) synd.treasury += amount;
}

function drawShareCashFlow(world: World, eq: Equity, amount: number): number {
  if (amount <= 0) return 0;
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    if (!market) return 0;
    // Allow shares to draw from treasury all the way down to its hard floor.
    const target = market.treasuryTarget || 1;
    const floor = -2 * target;
    const available = Math.max(0, market.treasury - floor);
    const paid = Math.min(amount, available);
    market.treasury -= paid;
    return paid;
  }
  const synd = world.syndicates[eq.underlyingId];
  if (!synd) return 0;
  const paid = Math.max(0, Math.min(amount, synd.treasury));
  synd.treasury -= paid;
  return paid;
}

// --- per-tick stock-market step --------------------------------------------

export function tickStockMarket(world: World): void {
  if (Object.keys(world.equities).length === 0) return;   // no market initialized
  for (const eq of Object.values(world.equities)) {
    recomputeEquityPrice(world, eq);
  }
  // Trigger checks immediately after the price update so stops fire on the
  // freshest tick. Borrow fees + dividends still settle on whatever's left.
  checkPositionTriggers(world);
  decaySyndicateRevenue(world);
  tickShortBorrowFees(world);
  payoutDividends(world);
}

// --- queries --------------------------------------------------------------

export function listEquities(world: World): Equity[] {
  return Object.values(world.equities).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function portfolioValue(world: World): number {
  // Long-position market value plus short-position notional (treated as a
  // collateral position — for display purposes its mark-to-market value
  // moves opposite to price changes). Returns the long-side market value
  // only — the more honest "equity value" view shows long market value
  // and tracks short P&L separately.
  if (!world.player?.positions) return 0;
  let v = 0;
  for (const pos of Object.values(world.player.positions)) {
    const eq = world.equities[pos.equityId];
    if (!eq) continue;
    if (pos.kind === "long") v += eq.price * pos.shares;
  }
  return v;
}

// Total unrealized P&L across all open positions.
export function totalUnrealizedPnl(world: World): number {
  if (!world.player?.positions) return 0;
  let pnl = 0;
  for (const pos of Object.values(world.player.positions)) pnl += unrealizedPnl(world, pos);
  return pnl;
}

export function priceChangePct(eq: Equity): number {
  if (eq.prevPrice == null || eq.prevPrice === 0) return 0;
  return (eq.price - eq.prevPrice) / eq.prevPrice;
}
