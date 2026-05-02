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
  BookTrade,
  Equity,
  EquityId,
  LocationId,
  OrderSide,
  Player,
  StockPosition,
  Syndicate,
  SyndicateId,
  TradeAction,
  TradeRecord,
  Trader,
  TraderId,
  TriggerKind,
  World,
} from "./types";
import { mulberry32 } from "./gen/rng";
import { combinedShipModifiers, dividendBonusFraction } from "./crew";
import { depositToTreasury } from "./economy";
import { eventMultiplier } from "./news/modifier";
import type { NewsScope } from "./news/types";
import { createTradeJob, exchangeLossForgiveness } from "./jobs";
import { pushNote } from "./log";
import { ageOrders, cancelAgentOrders, cancelOrder as cancelBookOrder, ensureOrderBook, executeMarketOrder, placeLimitOrder as placeBookLimit, simulateMarketOrder, matchBook } from "./stock/orderbook";
import { incrementManualActions } from "./milestones";
import { SYNTHETIC_MM_AGENT_ID } from "./stock/market-maker";
import { applyAgentFill, seedAgentPositions, stepStockAgents, warmUpBook } from "./stock/agents";
import {
  applyAgentFuturesFill,
  ensureFuturesListings,
  FUTURES_AGENT_CARRY_BPS,
  markPriceFor,
  tickFutures,
} from "./stock/futures";

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
export const SYNDICATE_PRICE_REVENUE_WEIGHT = 0.00003; // how much revenue tilts price
export const SYNDICATE_WEALTH_RATIO_MIN = 0.2;
export const SYNDICATE_WEALTH_RATIO_MAX = 3.0;
export const SYNDICATE_WEALTH_MULT_MIN = 0.6;
export const SYNDICATE_WEALTH_MULT_MAX = 1.85;
export const SYNDICATE_REVENUE_MULT_CAP = 0.25;
export const COMMODITY_SHORTAGE_WEIGHT_FRACTION = 0.08;
export const SHORT_BORROWABLE_FLOAT_FRACTION = 0.35;
export const SHORT_LENDABLE_POSITION_FRACTION = 0.5;

export const SHARE_PRICE_HISTORY_MAX = 150;    // capped history per equity (also the per-save retention)
export const RECENT_TRADES_MAX = 100;          // capped tape per equity (T&S + volume window)

// Per-tick borrow fee on a short position's notional value. A real cost
// (in real markets, paid to whoever lent the shares). Kept small so daily
// holds don't bleed out, but enough that infinitely-held shorts aren't free.
export const SHORT_BORROW_RATE_PER_TICK = 0.0001;
export const TRADE_LEDGER_MAX = 200;
export const EXCHANGE_TRADE_MAX_HOPS = 3;

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

// Commodity equity — one per traded good. Backed by a volume-weighted
// spot index across all stations. Anchor = good.basePrice (the canonical
// price of the good across the universe). Tradable from anywhere.
export function createCommodityEquity(good: { id: string; name: string; basePrice: number }): Equity {
  const anchor = Math.max(1, good.basePrice);
  return {
    id: `eq_com_${good.id}`,
    kind: "commodity",
    name: good.name,
    ticker: tickerFromName(good.name),
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: anchor,
    anchorPrice: anchor,
    underlyingId: good.id,
    history: [{ tick: 0, price: anchor }],
  };
}

// C-2: Basis pair listing — tracks one station's local price for one good.
// Long the listing = bullish on that station's local price relative to its
// anchor (good.basePrice). The "basis" vs the universe spot is a derived
// number shown in the UI; the listing itself trades on the station's local
// price directly so the existing clamp / EMA / order-book infrastructure
// applies unchanged.
//
// underlyingId composite: "<locationId>::<goodId>". Helpers below parse
// it back out. Sticking to a string keeps the Equity shape unchanged.
export function basisUnderlying(loc: string, good: string): string {
  return `${loc}::${good}`;
}
export function parseBasisUnderlying(underlyingId: string): { locationId: string; goodId: string } | null {
  const idx = underlyingId.indexOf("::");
  if (idx < 0) return null;
  return { locationId: underlyingId.slice(0, idx), goodId: underlyingId.slice(idx + 2) };
}
export function createBasisEquity(
  loc: { id: string; name: string },
  good: { id: string; name: string; basePrice: number },
): Equity {
  const anchor = Math.max(1, good.basePrice);
  const stationTag = (loc.name.match(/[A-Za-z]+/)?.[0] ?? loc.id).slice(0, 3).toUpperCase();
  const goodTag = (good.name.match(/[A-Za-z]+/)?.[0] ?? good.id).slice(0, 3).toUpperCase();
  return {
    id: `eq_bas_${loc.id}_${good.id}`,
    kind: "basis",
    name: `${loc.name} ${good.name} basis`,
    ticker: `${stationTag}${goodTag}`.slice(0, 6),
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: anchor,
    anchorPrice: anchor,
    underlyingId: basisUnderlying(loc.id, good.id),
    history: [{ tick: 0, price: anchor }],
  };
}

// C-2: cap on basis-pair listings created at world creation. Bounded so
// the Exchange screen stays browsable on big worlds. Two pairs per
// location (top exporter + top consumer good) bounded by this global
// cap.
export const BASIS_PAIRS_PER_LOCATION = 2;
export const BASIS_PAIRS_GLOBAL_CAP = 20;

function seedBasisPairs(world: World): void {
  const created = new Set<string>();
  let total = 0;

  // Stable iteration: sort locations by id so the same world seeds the
  // same pairs run-to-run.
  const locations = Object.values(world.locations).sort((a, b) => a.id.localeCompare(b.id));
  for (const loc of locations) {
    if (total >= BASIS_PAIRS_GLOBAL_CAP) break;
    // Score every good by absolute net-production rate at this station.
    // Top |net rate| = "most-tradable" basis pair from this station.
    const scored: { goodId: string; absRate: number; net: number }[] = [];
    for (const good of Object.values(world.goods)) {
      if (good.category === "upgrade") continue;
      const produced = loc.produces.find(p => p.good === good.id)?.ratePerTick ?? 0;
      const consumed = loc.consumes.find(c => c.good === good.id)?.ratePerTick ?? 0;
      const net = produced - consumed;
      if (net === 0) continue;
      scored.push({ goodId: good.id, absRate: Math.abs(net), net });
    }
    // Pick the top exporter and top importer. (If a location only
    // produces or only consumes, just take the top |net|.)
    scored.sort((a, b) => b.absRate - a.absRate);
    const picks: string[] = [];
    const exporter = scored.find(s => s.net > 0);
    const importer = scored.find(s => s.net < 0);
    if (exporter) picks.push(exporter.goodId);
    if (importer && importer.goodId !== exporter?.goodId) picks.push(importer.goodId);
    // Round out to BASIS_PAIRS_PER_LOCATION with the next-best |net|.
    for (const s of scored) {
      if (picks.length >= BASIS_PAIRS_PER_LOCATION) break;
      if (!picks.includes(s.goodId)) picks.push(s.goodId);
    }
    for (const goodId of picks) {
      if (total >= BASIS_PAIRS_GLOBAL_CAP) break;
      const good = world.goods[goodId];
      if (!good) continue;
      const key = basisUnderlying(loc.id, goodId);
      if (created.has(key)) continue;
      created.add(key);
      const eq = createBasisEquity(loc, good);
      world.equities[eq.id] = eq;
      total++;
    }
  }
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
  // Assign NPCs round-robin to syndicates. Stamp the trader's
  // syndicateId too so any caller using buildSyndicates as a fallback
  // (hand-built test worlds, save migrations) gets the same faction
  // wiring as a freshly-generated world.
  const ids = Object.keys(syndicates);
  for (let i = 0; i < npcIds.length; i++) {
    const synId = ids[i % ids.length];
    syndicates[synId].memberShipIds.push(npcIds[i]);
    const trader = world.traders[npcIds[i]];
    if (trader) trader.syndicateId = synId;
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
  // C-1: spot-index commodity per traded good (everything except the
  // upgrade catalogue). Anchor = good.basePrice, fundamental tracked by
  // commodityFundamental (volume-weighted spot across stations).
  for (const good of Object.values(world.goods)) {
    if (good.category === "upgrade") continue;
    const eq = createCommodityEquity(good);
    world.equities[eq.id] = eq;
  }
  // C-2: basis pairs — a handful of (station, good) listings tracking
  // each station's local price vs the spot index. We seed two pairs per
  // location (top exporter good + top consumer good) up to a soft global
  // cap. This keeps the listing count bounded on big worlds while
  // surfacing the most-tradable basis spreads.
  seedBasisPairs(world);
  // C-3: futures listings — near + far per traded good.
  ensureFuturesListings(world);
  // C-6: sector indices + Treasury Index Note. Indices are cash-settled
  // weighted baskets of commodities (sectors) or aggregate treasury
  // health (TIN).
  for (const def of SECTOR_INDICES) {
    const eq = createSectorIndexEquity(world, def);
    world.equities[eq.id] = eq;
  }
  {
    const tin = createTreasuryIndexEquity();
    world.equities[tin.id] = tin;
  }
  // Phase 2 (MM-less): distribute the float across NPC agents and warm up
  // the book — each agent posts both a bid and an ask on every equity using
  // noise-style passive offsets — so depth exists on both sides from frame
  // zero. After this initial seed the regular per-tick decision loop runs
  // style-specific logic.
  seedAgentPositions(world);
  warmUpBook(world);
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

export function clampSharePrice(eq: Equity, price: number): number {
  const floor = eq.anchorPrice * SHARE_PRICE_FLOOR_MULT;
  const ceiling = eq.anchorPrice * SHARE_PRICE_CEILING_MULT;
  return Math.max(floor, Math.min(ceiling, price));
}

// Per-kind fundamental computation. Each kind returns a price (not a
// multiplier) anchored on eq.anchorPrice. Kept as separate functions so
// new instrument kinds (commodity, basis pair, futures, index) slot in
// without growing one giant if/else.

// C-5: net-trade modifier coefficient. Tuned so a station with a
// steady netTradeFlow ≈ treasuryTarget over time gets ~+5% on its
// equity fundamental. Bounded to ±15% so a wild trade burst can't
// blow past the price clamp by itself.
export const NET_TRADE_MULT_PER_TARGET = 0.05;
export const NET_TRADE_MULT_CAP = 0.15;

export function stationNetTradeMultiplier(world: World, eq: Equity): number {
  if (eq.kind !== "station") return 1;
  const market = world.markets[eq.underlyingId];
  if (!market) return 1;
  const flow = market.netTradeFlow ?? 0;
  const target = Math.max(1, market.treasuryTarget);
  const raw = (flow / target) * NET_TRADE_MULT_PER_TARGET;
  const clamped = Math.max(-NET_TRADE_MULT_CAP, Math.min(NET_TRADE_MULT_CAP, raw));
  return 1 + clamped;
}

function stationFundamental(world: World, eq: Equity): number {
  const market = world.markets[eq.underlyingId];
  if (!market) return eq.anchorPrice;
  // Treasury health → multiplier on anchor.
  const target = Math.max(1, market.treasuryTarget);
  const treasuryRatio = market.treasury / target;
  let mult = 1.0;
  if (treasuryRatio >= 0) mult = 0.7 + 0.45 * Math.min(2, treasuryRatio);
  else mult = Math.max(0.3, 0.7 + treasuryRatio * 0.35);
  // C-5: net-trade modifier on top of treasury health. Productive
  // stations (consistent net exporters) trade at a premium.
  return eq.anchorPrice * mult * stationNetTradeMultiplier(world, eq);
}

function syndicateFundamental(world: World, eq: Equity): number {
  const synd = world.syndicates[eq.underlyingId];
  if (!synd) return eq.anchorPrice;
  const wealth = syndicateWealth(world, synd);
  const fairWealth = Math.max(1, synd.memberShipIds.length * 20_000);
  const wealthMult = syndicateWealthMultiplier(wealth / fairWealth);
  const revenueTilt = Math.max(0, Math.min(
    SYNDICATE_REVENUE_MULT_CAP,
    synd.recentRevenue * SYNDICATE_PRICE_REVENUE_WEIGHT,
  ));
  const revenueMult = 1 + revenueTilt;
  return eq.anchorPrice * wealthMult * revenueMult;
}

function syndicateWealthMultiplier(ratio: number): number {
  const clamped = Math.max(SYNDICATE_WEALTH_RATIO_MIN, Math.min(SYNDICATE_WEALTH_RATIO_MAX, ratio));
  if (clamped >= 1) {
    const t = (clamped - 1) / (SYNDICATE_WEALTH_RATIO_MAX - 1);
    return 1 + t * (SYNDICATE_WEALTH_MULT_MAX - 1);
  }
  const t = (clamped - SYNDICATE_WEALTH_RATIO_MIN) / (1 - SYNDICATE_WEALTH_RATIO_MIN);
  return SYNDICATE_WEALTH_MULT_MIN + t * (1 - SYNDICATE_WEALTH_MULT_MIN);
}

// Commodity fundamental — volume-weighted spot index across all stations
// for the underlying good. Glutted producers pull the spot down; empty
// shortage sites still get a small reserve weight instead of disappearing.
function commodityFundamental(world: World, eq: Equity): number {
  return commoditySpotPrice(world, eq.underlyingId, eq.anchorPrice);
}

function commoditySpotPrice(world: World, goodId: string, fallback: number): number {
  let numerator = 0;
  let denom = 0;
  const base = world.goods[goodId]?.basePrice ?? fallback;
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    if (!market) continue;
    const stock = market.stock[goodId] ?? 0;
    const price = market.prices[goodId];
    if (price == null || !Number.isFinite(price)) continue;
    const target = loc.targetStock[goodId] ?? 0;
    const stockWeight = Math.max(0, stock);
    const shortageWeight = target > 0 && price > base * 1.02
      ? target * COMMODITY_SHORTAGE_WEIGHT_FRACTION
      : 0;
    const weight = Math.max(stockWeight, shortageWeight);
    if (weight <= 0) continue;
    numerator += price * weight;
    denom += weight;
  }
  if (denom <= 0) return fallback;
  return numerator / denom;
}

// Basis fundamental — the station's local market price for the good.
// Falls back to the anchor (= good.basePrice) when the station's market
// is missing or the good isn't priced there.
function basisFundamental(world: World, eq: Equity): number {
  const parts = parseBasisUnderlying(eq.underlyingId);
  if (!parts) return eq.anchorPrice;
  const market = world.markets[parts.locationId];
  if (!market) return eq.anchorPrice;
  const local = market.prices[parts.goodId];
  if (local == null || !Number.isFinite(local)) return eq.anchorPrice;
  return local;
}

// Futures fundamental — spot × tiny per-tick carry. The futures equity's
// price gravitates toward the spot adjusted by time-to-expiry. As expiry
// nears, fair → spot.
function futuresFundamental(world: World, eq: Equity): number {
  const c = world.contracts?.[eq.id];
  if (!c) return eq.anchorPrice;
  const spot = markPriceFor(world, c);
  if (!Number.isFinite(spot) || spot <= 0) return eq.anchorPrice;
  const tte = Math.max(0, c.expiryTick - world.tick);
  return spot * (1 + FUTURES_AGENT_CARRY_BPS * tte);
}

// Compute the "fundamental" price for an equity from underlying signals.
// Every signal is converted to a multiplier on anchorPrice. The tick-by-tick
// EMA blend toward this fundamental drives the visible price.
export function computeFundamental(world: World, eq: Equity): number {
  switch (eq.kind) {
    case "station":   return stationFundamental(world, eq);
    case "syndicate": return syndicateFundamental(world, eq);
    case "commodity": return commodityFundamental(world, eq);
    case "basis":     return basisFundamental(world, eq);
    case "futures":   return futuresFundamental(world, eq);
    case "index":     return indexFundamental(world, eq);
  }
}

// --- C-6: sector indices + Treasury Index Note --------------------------

// Sector composition table. Each sector aggregates ~3-4 commodity equities
// into a basket priced as a weighted average of underlying spots. Cash-
// settled like commodity equities. Tradable from anywhere.
export interface IndexDef {
  id: EquityId;
  name: string;
  ticker: string;
  members: { goodId: string; weight: number }[]; // weights normalized to 1 internally
}

const SECTOR_INDICES: IndexDef[] = [
  {
    id: "eq_idx_food",
    name: "Food Sector Index",
    ticker: "FOOD",
    members: [
      { goodId: "grain", weight: 1 },
      { goodId: "protein", weight: 1 },
      { goodId: "vatmeat", weight: 1 },
    ],
  },
  {
    id: "eq_idx_raw",
    name: "Raw Materials Index",
    ticker: "RAW",
    members: [
      { goodId: "ore", weight: 1 },
      { goodId: "polymer", weight: 1 },
      { goodId: "fiber", weight: 1 },
    ],
  },
  {
    id: "eq_idx_advanced",
    name: "Advanced Goods Index",
    ticker: "ADV",
    members: [
      { goodId: "electronics", weight: 1 },
      { goodId: "weapons", weight: 1 },
      { goodId: "luxury_goods", weight: 1 },
      { goodId: "medkits", weight: 1 },
    ],
  },
  {
    id: "eq_idx_fuel",
    name: "Fuel Index",
    ticker: "FUEL",
    members: [
      { goodId: "plasma", weight: 1 },
      { goodId: "antimatter", weight: 1 },
    ],
  },
];

// Treasury Index Note — aggregate treasury health across all stations.
// Constant id; underlying is "all stations".
const TREASURY_INDEX_ID: EquityId = "eq_idx_tin";
const TREASURY_INDEX_TICKER = "TIN";
const TREASURY_INDEX_NAME = "Treasury Index Note";
const TREASURY_INDEX_ANCHOR = 100;

export function listSectorIndices(): IndexDef[] {
  return SECTOR_INDICES;
}

export function isIndexEquity(id: EquityId): boolean {
  return id === TREASURY_INDEX_ID || SECTOR_INDICES.some(s => s.id === id);
}

// Weighted-spot index. anchor = weighted sum of member basePrices so that
// at world creation, when each commodity is at anchor, the index sits at
// 1.0× (i.e., price = anchor).
export function createSectorIndexEquity(world: World, def: IndexDef): Equity {
  const totalWeight = def.members.reduce((s, m) => s + m.weight, 0) || 1;
  let anchor = 0;
  for (const m of def.members) {
    const good = world.goods[m.goodId];
    if (!good) continue;
    anchor += (m.weight / totalWeight) * Math.max(1, good.basePrice);
  }
  if (anchor <= 0) anchor = 100;
  return {
    id: def.id,
    kind: "index",
    name: def.name,
    ticker: def.ticker,
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: anchor,
    anchorPrice: anchor,
    underlyingId: def.id,
    history: [{ tick: 0, price: anchor }],
  };
}

export function createTreasuryIndexEquity(): Equity {
  return {
    id: TREASURY_INDEX_ID,
    kind: "index",
    name: TREASURY_INDEX_NAME,
    ticker: TREASURY_INDEX_TICKER,
    sharesOutstanding: SHARES_OUTSTANDING_DEFAULT,
    price: TREASURY_INDEX_ANCHOR,
    anchorPrice: TREASURY_INDEX_ANCHOR,
    underlyingId: TREASURY_INDEX_ID,
    history: [{ tick: 0, price: TREASURY_INDEX_ANCHOR }],
  };
}

// Lookup the IndexDef for a sector index. Returns null for non-sector
// indices (TIN) or unknown ids.
function indexDefById(id: EquityId): IndexDef | null {
  return SECTOR_INDICES.find(s => s.id === id) ?? null;
}

// Sector index fundamental — weighted sum of member commodity prices.
function sectorIndexFundamental(world: World, eq: Equity): number {
  const def = indexDefById(eq.id);
  if (!def) return eq.anchorPrice;
  const totalWeight = def.members.reduce((s, m) => s + m.weight, 0) || 1;
  let value = 0;
  for (const m of def.members) {
    const memberEq = world.equities[`eq_com_${m.goodId}`];
    if (!memberEq) continue;
    value += (m.weight / totalWeight) * memberEq.price;
  }
  if (value <= 0) return eq.anchorPrice;
  return value;
}

// Treasury Index fundamental — average treasury health across stations,
// scaled to the anchor (100). Health = treasury / target, clamped to a
// reasonable band so a single station deficit can't swing the index.
function treasuryIndexFundamental(world: World, eq: Equity): number {
  const markets = Object.values(world.markets);
  if (markets.length === 0) return eq.anchorPrice;
  let healthSum = 0;
  let n = 0;
  for (const m of markets) {
    if (m.treasuryTarget <= 0) continue;
    const ratio = m.treasury / m.treasuryTarget;
    healthSum += Math.max(-2, Math.min(2, ratio)); // bound contributions
    n++;
  }
  if (n === 0) return eq.anchorPrice;
  const avg = healthSum / n;
  return eq.anchorPrice * Math.max(0.1, Math.min(2, avg));
}

function indexFundamental(world: World, eq: Equity): number {
  if (eq.id === TREASURY_INDEX_ID) return treasuryIndexFundamental(world, eq);
  return sectorIndexFundamental(world, eq);
}

// C-2 helper for the UI — current spread of a basis listing's local
// price vs the universe spot index. Positive = local is more expensive
// than the spot. Returns the absolute difference, not a ratio.
export function basisSpreadVsSpot(world: World, eq: Equity): number {
  const parts = parseBasisUnderlying(eq.underlyingId);
  if (!parts) return 0;
  const local = world.markets[parts.locationId]?.prices[parts.goodId];
  if (local == null) return 0;
  const spot = commoditySpotPrice(world, parts.goodId, eq.anchorPrice);
  return local - spot;
}

interface PriceDynamicsProfile {
  smoothing: number;
  noise: number;
  sentimentDecay: number;
  sentimentShock: number;
  sentimentPressure: number;
  sentimentCap: number;
}

const PRICE_DYNAMICS_BY_KIND: Record<Equity["kind"], PriceDynamicsProfile> = {
  station: {
    smoothing: 0.075,
    noise: 0.0022,
    sentimentDecay: 0.965,
    sentimentShock: 0.0008,
    sentimentPressure: 0.015,
    sentimentCap: 0.025,
  },
  syndicate: {
    smoothing: 0.060,
    noise: 0.0032,
    sentimentDecay: 0.955,
    sentimentShock: 0.0012,
    sentimentPressure: 0.012,
    sentimentCap: 0.035,
  },
  commodity: {
    smoothing: 0.135,
    noise: 0.0038,
    sentimentDecay: 0.940,
    sentimentShock: 0.0015,
    sentimentPressure: 0.010,
    sentimentCap: 0.035,
  },
  basis: {
    smoothing: 0.155,
    noise: 0.0045,
    sentimentDecay: 0.930,
    sentimentShock: 0.0018,
    sentimentPressure: 0.010,
    sentimentCap: 0.045,
  },
  futures: {
    smoothing: 0.180,
    noise: 0.0030,
    sentimentDecay: 0.920,
    sentimentShock: 0.0014,
    sentimentPressure: 0.006,
    sentimentCap: 0.028,
  },
  index: {
    smoothing: 0.075,
    noise: 0.0016,
    sentimentDecay: 0.970,
    sentimentShock: 0.0006,
    sentimentPressure: 0.006,
    sentimentCap: 0.018,
  },
};

function priceDynamicsProfile(world: World, eq: Equity): PriceDynamicsProfile {
  const base = PRICE_DYNAMICS_BY_KIND[eq.kind];
  if (eq.kind !== "futures") return base;
  const c = world.contracts?.[eq.id];
  if (!c) return base;
  const tte = Math.max(0, c.expiryTick - world.tick);
  if (tte >= 80) return base;
  const urgency = 1 - tte / 80;
  return {
    ...base,
    smoothing: base.smoothing + urgency * 0.12,
    sentimentCap: base.sentimentCap * (1 - urgency * 0.45),
  };
}

function deterministicUnitNoise(eq: Equity, tick: number, salt = 0): number {
  // Per-equity seeded noise so prices wiggle realistically. Same world tick
  // → same noise (determinism preserved).
  const seed = (hashStr(eq.id) ^ Math.imul(tick + 1, 0x45d9f3b) ^ salt) | 0;
  const rng = mulberry32(seed);
  return (rng() - 0.5) * 2;
}

function deterministicNoise(eq: Equity, tick: number, scale = SHARE_PRICE_NOISE): number {
  return deterministicUnitNoise(eq, tick) * scale;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function updateMarketMood(world: World, eq: Equity, fundamental: number, profile: PriceDynamicsProfile): number {
  const prev = Number.isFinite(eq.marketMood) ? eq.marketMood! : 0;
  const pressure = eq.price > 0
    ? Math.max(-1, Math.min(1, (fundamental - eq.price) / eq.price))
    : 0;
  const innovation = deterministicUnitNoise(eq, world.tick, 0x51f15eed) * profile.sentimentShock;
  const next = prev * profile.sentimentDecay + innovation + pressure * profile.sentimentPressure;
  eq.marketMood = Math.max(-profile.sentimentCap, Math.min(profile.sentimentCap, next));
  return eq.marketMood;
}

// Map an equity's kind to the news scope that targets it, plus the ctx the
// event matcher needs to bind. Returns 1 (no-op) for kinds not covered.
function equityEventMultiplier(world: World, eq: Equity): number {
  let scope: NewsScope | null = null;
  switch (eq.kind) {
    case "station":   scope = "share_price_station"; break;
    case "syndicate": scope = "share_price_syndicate"; break;
    case "commodity": scope = "commodity_index_price"; break;
    case "basis":     scope = "basis_price"; break;
    case "futures":   scope = "futures_price"; break;
    case "index":     scope = "commodity_index_price"; break;
  }
  if (!scope) return 1;
  // Bind by underlying so a "station X" event hits only that station's equity.
  if (eq.kind === "station") {
    return eventMultiplier(world, scope, { locationId: eq.underlyingId });
  }
  if (eq.kind === "syndicate") {
    return eventMultiplier(world, scope, { syndicateId: eq.underlyingId });
  }
  // For commodity/basis/futures/index equities the underlying is a good or
  // contract id — pass through as indexId so matchers can target by id.
  return eventMultiplier(world, scope, { indexId: eq.id });
}

export function computeEventAdjustedFundamental(world: World, eq: Equity): number {
  return computeFundamental(world, eq) * equityEventMultiplier(world, eq);
}

export function recomputeEquityPrice(world: World, eq: Equity): void {
  // News events apply as a final scalar on the per-tick fundamental — placed
  // here (after computeFundamental) rather than inside each *Fundamental
  // helper so the kick is felt fully and consistently across kinds, instead
  // of being cushioned by per-kind smoothing internals.
  const fundamental = computeEventAdjustedFundamental(world, eq);
  const profile = priceDynamicsProfile(world, eq);
  const mood = updateMarketMood(world, eq, fundamental, profile);
  // EMA blend — per-kind smoothing so thin/local instruments can react faster
  // than broad indices while still respecting their underlying fair value.
  const target = fundamental * (1 + mood);
  const blended = eq.price + profile.smoothing * (target - eq.price);
  // Add small per-tick noise scaled by current price so it's proportional.
  const noisy = blended * (1 + deterministicNoise(eq, world.tick, profile.noise));
  eq.prevPrice = eq.price;
  eq.price = clampSharePrice(eq, noisy);
  // Append history, capped
  if (!eq.history) eq.history = [];
  const lastHistory = eq.history[eq.history.length - 1];
  if (lastHistory?.tick === world.tick) {
    lastHistory.price = eq.price;
  } else {
    eq.history.push({ tick: world.tick, price: eq.price });
  }
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
      const divMult = eventMultiplier(world, "dividend", { locationId: eq.underlyingId });
      sourceFunds = surplus * DIVIDEND_PAYOUT_FRACTION * divMult;
      sinkFn = (amount) => { market.treasury -= amount; };
    } else if (eq.kind === "syndicate") {
      const synd = world.syndicates[eq.underlyingId];
      if (!synd || synd.treasury <= 0) continue;
      const divMult = eventMultiplier(world, "dividend", { syndicateId: eq.underlyingId });
      sourceFunds = synd.treasury * DIVIDEND_PAYOUT_FRACTION * divMult;
      sinkFn = (amount) => { synd.treasury -= amount; };
    } else {
      // C-1/C-2: commodity + basis equities pay no dividends. They have no
      // underlying treasury — value comes from price moves and short
      // borrow fees.
      continue;
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
        const basePayout = perShare * position.shares;
        // Dividend bonus is paid on top of the base payout. The treasury
        // still only loses the base; the bonus is sourced as an "investor
        // relations subsidy" outside the closed loop. Small enough to
        // not perturb long-run economy invariants.
        const bonus = basePayout * dividendBonusFraction(playerShip);
        playerShip.funds += basePayout + bonus;
        if (sinkFn) sinkFn(basePayout);
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
  | { ok: true; shares: number; cashFlow: number; fee: number; realizedPnl?: number; settlementJobId?: string }
  | { ok: false; reason: string };

function getPlayerShip(world: World, preferredShipId?: TraderId) {
  if (!world.player) return null;
  const id = preferredShipId && world.player.shipIds.includes(preferredShipId)
    ? preferredShipId
    : world.player.shipIds[0];
  const ship = id ? world.traders[id] ?? null : null;
  if (ship && (!preferredShipId || id === world.player.shipIds[0])) {
    syncPlayerStockBook(world.player, ship);
  }
  return ship;
}

type StockBookOwner = Player | Trader;

function isPlayerStockBookOwner(owner: StockBookOwner): owner is Player {
  return "shipIds" in owner;
}

function syncPlayerStockBook(player: Player, ship: Trader): void {
  // Back-compat alias: the legacy `player.*` fields share the same object
  // reference as the first ship's per-ship state. Old readers keep working
  // (UI views, tests) while new writes go through `ship.*` and are visible
  // through both. New ships beyond the first hold their own state — only
  // the first ship is mirrored onto the player record.
  const positions = player.positions ?? ship.stockPositions ?? {};
  player.positions = positions;
  ship.stockPositions = positions;

  const trades = player.trades ?? ship.stockTrades ?? [];
  player.trades = trades;
  ship.stockTrades = trades;

  const reservedShares = player.reservedShares ?? ship.reservedShares ?? {};
  player.reservedShares = reservedShares;
  ship.reservedShares = reservedShares;

  const futures = player.futures ?? ship.futures ?? {};
  player.futures = futures;
  ship.futures = futures;

  const reservedFutures = player.reservedFutures ?? ship.reservedFutures ?? {};
  player.reservedFutures = reservedFutures;
  ship.reservedFutures = reservedFutures;
}

function ensurePositions(owner: StockBookOwner): Record<EquityId, StockPosition> {
  if (isPlayerStockBookOwner(owner)) {
    if (!owner.positions) owner.positions = {};
    return owner.positions;
  }
  if (!owner.stockPositions) owner.stockPositions = {};
  return owner.stockPositions;
}

function ensureTrades(owner: StockBookOwner): TradeRecord[] {
  if (isPlayerStockBookOwner(owner)) {
    if (!owner.trades) owner.trades = [];
    return owner.trades;
  }
  if (!owner.stockTrades) owner.stockTrades = [];
  return owner.stockTrades;
}

function ensureReservedShares(owner: StockBookOwner): Record<EquityId, number> {
  if (isPlayerStockBookOwner(owner)) {
    if (!owner.reservedShares) owner.reservedShares = {};
    return owner.reservedShares;
  }
  if (!owner.reservedShares) owner.reservedShares = {};
  return owner.reservedShares;
}

let nextTradeIdCounter = 1;
function makeTradeId(world: World): string {
  return `tr_${world.tick}_${nextTradeIdCounter++}`;
}

function recordTrade(
  world: World,
  trader: StockBookOwner,
  eq: Equity,
  action: TradeAction,
  shares: number,
  price: number,
  fee: number,
  cashFlow: number,
  realizedPnl?: number,
  trigger?: TriggerKind,
): TradeRecord {
  const trades = ensureTrades(trader);
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

function createStationTradeSettlement(
  world: World,
  shipId: TraderId,
  eq: Equity,
  action: Extract<TradeAction, "close_long" | "cover_short">,
  shares: number,
  realizedPnl: number,
): string | undefined {
  const destination = equityTradeStation(eq);
  if (!destination) return undefined;
  const settlementKind = realizedPnl >= 0 ? "profit" : "loss_forgiveness";
  const reward = realizedPnl >= 0 ? realizedPnl : exchangeLossForgiveness(-realizedPnl);
  if (reward <= 0) return undefined;
  const ship = world.traders[shipId];
  if (ship && (combinedShipModifiers(ship).remoteSettlementCollection ?? 0) >= 1) {
    ship.funds += reward;
    pushNote(
      world,
      ship,
      `Exchange relay collected ${eq.ticker} ${settlementKind === "profit" ? "profit" : "loss review"} — Ç${Math.round(reward).toLocaleString()} paid`,
      "good",
    );
    return undefined;
  }
  return createTradeJob(world, {
    traderId: shipId,
    destination,
    equityId: eq.id,
    ticker: eq.ticker,
    action,
    shares,
    realizedPnl,
    reward,
    settlementKind,
  })?.id;
}

interface TradeContext {
  player: Player;
  eq: Equity;
  ship: ReturnType<typeof getPlayerShip>;
}

export function equityTradeStation(eq: Equity): LocationId | null {
  return eq.kind === "station" ? eq.underlyingId : null;
}

export function equityTradeHopDistance(world: World, eq: Equity, from: LocationId): number | null {
  const station = equityTradeStation(eq);
  if (!station) return 0;
  if (from === station) return 0;
  const hasRouteNetwork = Object.values(world.lanes).some(edges => Object.keys(edges).length > 0);
  if (!hasRouteNetwork) return 1;
  const seen = new Set<LocationId>([from]);
  const queue: { id: LocationId; hops: number }[] = [{ id: from, hops: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.hops >= EXCHANGE_TRADE_MAX_HOPS) continue;
    for (const next of Object.keys(world.lanes[current.id] ?? {}) as LocationId[]) {
      if (seen.has(next)) continue;
      if (next === station) return current.hops + 1;
      seen.add(next);
      queue.push({ id: next, hops: current.hops + 1 });
    }
  }
  return null;
}

// Tradability dispatch — each instrument kind decides its own access
// rule. `null` reason = ok to trade. Returning a string blocks the trade
// with that reason.
//
// Stations: must be within EXCHANGE_TRADE_MAX_HOPS hops of the listed
// station. Syndicates: tradable from anywhere (network access). Future
// kinds (commodity, futures, index) will add their own clauses here.
export function equityTradabilityReason(
  world: World,
  eq: Equity,
  ship: NonNullable<TradeContext["ship"]>,
): string | null {
  switch (eq.kind) {
    case "station": {
      const hops = equityTradeHopDistance(world, eq, ship.location);
      if (hops != null && hops <= EXCHANGE_TRADE_MAX_HOPS) return null;
      const station = equityTradeStation(eq);
      const stationName = (station ? world.locations[station]?.name : null) ?? station ?? eq.ticker;
      return `Move within ${EXCHANGE_TRADE_MAX_HOPS} hops of ${stationName} to trade ${eq.ticker}.`;
    }
    case "syndicate":
    case "commodity":
    case "basis":
    case "futures":
    case "index":
      return null;
  }
}

function proximityBlockReason(world: World, eq: Equity, ship: NonNullable<TradeContext["ship"]>): string | null {
  return equityTradabilityReason(world, eq, ship);
}

// --- order-book execution helpers ---------------------------------------
// Phase 1: route player trades through the order book. The MM is the only
// counterparty so cash always flows through the underlying treasury, same
// as today. The "execution price" comes from the trades printed by the
// book — possibly a weighted average across multiple fills if the order
// walks past the MM's first level.

interface BookExecution {
  ok: true;
  filled: number;
  unfilled: number;
  totalCash: number;        // sum of qty * price across all fills
  weightedAvgPrice: number; // totalCash / filled
  trades: BookTrade[];
  lastPrice: number;        // final fill price, used to update eq.price
}

interface BookExecutionEmpty { ok: false; reason: string }

function recordRecentTrades(eq: Equity, trades: BookTrade[]): void {
  if (trades.length === 0) return;
  if (!eq.recentTrades) eq.recentTrades = [];
  eq.recentTrades.push(...trades);
  if (eq.recentTrades.length > RECENT_TRADES_MAX) {
    eq.recentTrades.splice(0, eq.recentTrades.length - RECENT_TRADES_MAX);
  }
}

// Settle a single Trade's cash + position bookkeeping for the NON-PLAYER
// sides. The caller passes `playerShipId` (or undefined) to identify which
// counterparty to skip — the player's funds, position, fee, and settlement
// jobs are managed at the call site (buyShares / sellShares / etc.) since
// they have richer per-call logic. Agents and the synthetic MM are settled
// here:
//   * MM as buyer  → cash drawn from underlying treasury
//   * MM as seller → cash deposited to underlying treasury
//   * Agent as buyer  → funds debited, AgentPosition += qty (long)
//   * Agent as seller → funds credited, AgentPosition -= qty (long)
function settleNonPlayerTradeSides(
  world: World,
  eq: Equity,
  trade: BookTrade,
  playerShipId?: string,
): void {
  const cash = trade.qty * trade.price;
  const isFutures = eq.kind === "futures";

  // Buyer pays cash. NPC agents pay from their dedicated stockWallet (kept
  // separate from cargo trader.funds). Player side is skipped here — the
  // call site lump-sums it.
  if (trade.buyer === SYNTHETIC_MM_AGENT_ID) {
    drawShareCashFlow(world, eq, cash);
  } else if (trade.buyer !== playerShipId) {
    const t = world.traders[trade.buyer];
    if (t?.stockState) {
      if (isFutures) {
        // Futures: bookkeeping happens in applyAgentFuturesFill —
        // margin debit + AgentFuturesPosition, not full cash + share
        // position.
        applyAgentFuturesFill(world, t, eq.id, +trade.qty, trade.price);
      } else {
        // Share trade: strict P2P. Wallets can go negative — clipping
        // them at zero would credit the seller the full cash while the
        // buyer pays only what they had, creating money.
        t.stockState.stockWallet -= cash;
        applyAgentFill(t, eq.id, +trade.qty, trade.price, world.tick);
      }
    }
  }

  // Seller receives cash into stockWallet.
  if (trade.seller === SYNTHETIC_MM_AGENT_ID) {
    routeShareCashFlow(world, eq, cash);
  } else if (trade.seller !== playerShipId) {
    const t = world.traders[trade.seller];
    if (t?.stockState) {
      if (isFutures) {
        applyAgentFuturesFill(world, t, eq.id, -trade.qty, trade.price);
      } else {
        t.stockState.stockWallet += cash;
        applyAgentFill(t, eq.id, -trade.qty, trade.price, world.tick);
      }
    }
  }
}

function settleAllNonPlayerSides(world: World, eq: Equity, trades: BookTrade[], playerShipId?: string): void {
  for (const t of trades) settleNonPlayerTradeSides(world, eq, t, playerShipId);
}

// Phase 4: when a player limit order fills inside matchBook, the player
// side needs its own bookkeeping (settleNonPlayerTradeSides skips the
// player). Buys: position grows by fill qty (funds were debited at
// placement; price improvement is refunded on fill). Sells: ship.funds
// credited net of fee, position shrinks, reservedShares decremented.
function settlePlayerLimitFills(world: World, eq: Equity, trades: BookTrade[]): void {
  const player = world.player;
  if (!player) return;
  const playerShipIds = new Set(player.shipIds);

  for (const trade of trades) {
    if (playerShipIds.has(trade.buyer)) {
      // Player limit BUY filled. Funds were already debited (gross + fee).
      // Update the buying ship's position with weighted-average entry price,
      // refund any price improvement versus the reserved limit, and record
      // the actual fill economics in that ship's trade ledger.
      const ship = world.traders[trade.buyer];
      if (!ship) continue;
      const positions = ensurePositions(ship);
      const cur = positions[eq.id];
      const action: TradeAction = cur?.kind === "long" ? "add_long" : "open_long";
      if (cur?.kind === "long") {
        const totalShares = cur.shares + trade.qty;
        cur.avgEntryPrice = (cur.avgEntryPrice * cur.shares + trade.price * trade.qty) / totalShares;
        cur.shares = totalShares;
      } else if (!cur) {
        positions[eq.id] = {
          equityId: eq.id, kind: "long", shares: trade.qty, avgEntryPrice: trade.price, openedAt: world.tick,
        };
      }
      const reservedPrice = trade.buyerLimitPrice ?? trade.price;
      const reservedTotal = trade.qty * reservedPrice * (1 + BROKER_FEE_RATE);
      const actualTotal = trade.qty * trade.price * (1 + BROKER_FEE_RATE);
      ship.funds += Math.max(0, reservedTotal - actualTotal);
      const actualGross = trade.qty * trade.price;
      const fee = actualGross * BROKER_FEE_RATE;
      recordTrade(world, ship, eq, action, trade.qty, trade.price, fee, -(actualGross + fee));
    } else if (playerShipIds.has(trade.seller)) {
      // Player limit SELL filled. Credit selling ship's funds (gross − fee),
      // shrink that ship's position, decrement its reservedShares.
      const ship = world.traders[trade.seller];
      if (!ship) continue;
      const positions = ensurePositions(ship);
      const reservedShares = ensureReservedShares(ship);
      const gross = trade.qty * trade.price;
      const fee = gross * BROKER_FEE_RATE;
      const net = gross - fee;
      ship.funds += net;
      const cur = positions[eq.id];
      let realizedPnl: number | undefined;
      if (cur?.kind === "long") {
        const basis = cur.avgEntryPrice * trade.qty;
        realizedPnl = net - basis;
        cur.shares -= trade.qty;
        if (cur.shares <= 0.0001) delete positions[eq.id];
      }
      reservedShares[eq.id] = Math.max(0, (reservedShares[eq.id] ?? 0) - trade.qty);
      recordTrade(world, ship, eq, "close_long", trade.qty, trade.price, fee, net, realizedPnl);
    }
  }
}

function executeAgainstBook(
  world: World,
  eq: Equity,
  side: OrderSide,
  qty: number,
  agentId: TraderId,
  worstPrice?: number,
): BookExecution | BookExecutionEmpty {
  const result = executeMarketOrder(world, { equityId: eq.id, side, qty, agentId, worstPrice });
  if (result.filled <= 0) {
    return { ok: false, reason: `${eq.ticker} book is too thin to fill that order right now.` };
  }
  let totalCash = 0;
  for (const t of result.trades) totalCash += t.qty * t.price;
  const lastPrice = result.trades[result.trades.length - 1].price;
  eq.prevPrice = eq.price;
  eq.price = clampSharePrice(eq, lastPrice);
  recordRecentTrades(eq, result.trades);
  // Settle the COUNTERPARTY side of each fill. The aggressor (`agentId`,
  // typically the player's ship) keeps its funds-and-positions handled by
  // the caller (buyShares / sellShares / etc.) at the lump-sum level —
  // skipping it here avoids double-counting.
  settleAllNonPlayerSides(world, eq, result.trades, agentId);
  return {
    ok: true,
    filled: result.filled,
    unfilled: result.unfilled,
    totalCash,
    weightedAvgPrice: totalCash / result.filled,
    trades: result.trades,
    lastPrice,
  };
}

// Read-only counterpart used by preflight cost checks (player fund adequacy).
// Returns the cost the order WOULD pay against the current book.
function previewBookCost(
  world: World,
  eq: Equity,
  side: OrderSide,
  qty: number,
  agentId: TraderId,
): { fillable: number; totalCash: number } {
  const sim = simulateMarketOrder(world, { equityId: eq.id, side, qty, agentId });
  let totalCash = 0;
  for (const t of sim.trades) totalCash += t.qty * t.price;
  return { fillable: sim.filled, totalCash };
}

function preflight(world: World, equityId: EquityId, shares: number, shipId?: TraderId): TradeContext | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  if (shares <= 0 || !Number.isFinite(shares)) return { ok: false, reason: "Quantity must be positive." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  if (eq.kind === "futures") {
    return { ok: false, reason: "Futures contracts use openLongFuture / openShortFuture / closeFuture." };
  }
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  if (ship.state !== "idle") return { ok: false, reason: "Trade only while docked." };
  const proximityReason = proximityBlockReason(world, eq, ship);
  if (proximityReason) return { ok: false, reason: proximityReason };
  return { player: world.player, eq, ship };
}

// Open or add to a long position.
export function buyShares(world: World, equityId: EquityId, shares: number, shipId?: TraderId): StockTradeResult {
  const ctx = preflight(world, equityId, shares, shipId);
  if ("ok" in ctx) return ctx;
  const { eq, ship } = ctx;
  const positions = ensurePositions(ship!);
  const current = positions[equityId];
  if (current?.kind === "short") {
    return { ok: false, reason: `Currently short ${current.shares} ${eq.ticker}. Cover the short before going long.` };
  }
  // Cap by float not held
  const owned = current?.shares ?? 0;
  const maxBuyable = Math.max(0, eq.sharesOutstanding - owned);
  if (shares > maxBuyable) return { ok: false, reason: `Only ${maxBuyable} shares available on the float.` };

  // Preflight: walk the book read-only to compute would-be cost. Reject if
  // the book can't fill the requested qty or the player can't afford it.
  const preview = previewBookCost(world, eq, "bid", shares, ship!.id);
  if (preview.fillable < shares) {
    return { ok: false, reason: `${eq.ticker} book has only ${preview.fillable} share${preview.fillable === 1 ? "" : "s"} on offer.` };
  }
  const previewFee = preview.totalCash * BROKER_FEE_RATE;
  if (ship!.funds < preview.totalCash + previewFee) {
    return { ok: false, reason: `Need Ç${Math.round(preview.totalCash + previewFee).toLocaleString()}, have Ç${Math.round(ship!.funds).toLocaleString()}.` };
  }

  // Commit: execute against the book.
  const exec = executeAgainstBook(world, eq, "bid", shares, ship!.id);
  if (!exec.ok) return { ok: false, reason: exec.reason };
  const cost = exec.totalCash;
  const fee = cost * BROKER_FEE_RATE;
  const total = cost + fee;

  // Player pays cost + fee. The cost itself was already routed per-fill by
  // settleNonPlayerTradeSides inside executeAgainstBook (treasury for MM
  // sellers, agent funds for agent sellers). The fee is destroyed here.
  ship!.funds -= total;

  if (!current) {
    positions[equityId] = {
      equityId,
      kind: "long",
      shares: exec.filled,
      avgEntryPrice: exec.weightedAvgPrice,
      openedAt: world.tick,
    };
    recordTrade(world, ship!, eq, "open_long", exec.filled, exec.weightedAvgPrice, fee, -total);
  } else {
    // Weighted-average entry price across the combined position
    const totalShares = current.shares + exec.filled;
    current.avgEntryPrice = (current.avgEntryPrice * current.shares + exec.weightedAvgPrice * exec.filled) / totalShares;
    current.shares = totalShares;
    recordTrade(world, ship!, eq, "add_long", exec.filled, exec.weightedAvgPrice, fee, -total);
  }
  incrementManualActions(world);
  return { ok: true, shares: exec.filled, cashFlow: -total, fee };
}

// Close (or partially close) a long position. `trigger` is set when this
// runs from the per-tick stop-loss / take-profit check; the trade ledger
// records it so the player can scan for auto-fired closes.
export function sellShares(
  world: World,
  equityId: EquityId,
  shares: number,
  trigger?: TriggerKind,
  shipId?: TraderId,
): StockTradeResult {
  const ctx = preflight(world, equityId, shares, shipId);
  if ("ok" in ctx) return ctx;
  const { eq, ship } = ctx;
  const positions = ensurePositions(ship!);
  const current = positions[equityId];
  if (!current || current.kind !== "long") {
    return { ok: false, reason: `No long position in ${eq.ticker}.` };
  }
  if (shares > current.shares) return { ok: false, reason: `Only ${current.shares} shares owned.` };

  // Sell aggresses against the bid side of the book. Walk to compute the
  // realized proceeds at actual fill prices. Per-fill cash flow already
  // ran inside executeAgainstBook — for MM buyers the treasury was drawn
  // (with haircut if depleted), for agent buyers the agent's funds were
  // debited. The player still credits realized = sum of nominal fills,
  // applies broker fee.
  const exec = executeAgainstBook(world, eq, "ask", shares, ship!.id);
  if (!exec.ok) return { ok: false, reason: exec.reason };
  const realized = exec.totalCash;
  const fee = realized * BROKER_FEE_RATE;
  const net = realized - fee;

  const basis = current.avgEntryPrice * exec.filled;
  const realizedPnl = net - basis;
  let immediateCashFlow = net;
  let settlementJobId: string | undefined;
  if (eq.kind === "station") {
    if (realizedPnl > 0) {
      // Return capital now; station-side profit clears only when collected.
      immediateCashFlow = Math.min(net, basis);
    }
    settlementJobId = createStationTradeSettlement(world, ship!.id, eq, "close_long", exec.filled, realizedPnl);
  }
  ship!.funds += immediateCashFlow;

  current.shares -= exec.filled;
  if (current.shares <= 0.0001) delete positions[equityId];
  recordTrade(world, ship!, eq, "close_long", exec.filled, exec.weightedAvgPrice, fee, immediateCashFlow, realizedPnl, trigger);
  // Auto-fired stop-loss / take-profit don't count as manual play.
  if (!trigger) incrementManualActions(world);
  return { ok: true, shares: exec.filled, cashFlow: immediateCashFlow, fee, realizedPnl, settlementJobId };
}

// Shares available to borrow for a player short. This is deliberately about
// the lendable float, not the underlying treasury. The short-sale cash comes
// from whichever bid the player sells into; treasury only matters if a legacy
// synthetic market-maker quote is still present, and those are removed before
// player shorts execute.
function maxBorrowableShortShares(world: World, eq: Equity, shipId?: TraderId): number {
  if (eq.price <= 0 || eq.kind === "futures") return 0;
  // Cap by the borrowing ship's existing short — opening another short on
  // the same equity from the same ship counts toward the same short pool.
  const ship = getPlayerShip(world, shipId);
  const currentShort = ship?.stockPositions?.[eq.id]?.kind === "short"
    ? ship.stockPositions[eq.id].shares
    : 0;
  const floatCap = Math.floor(eq.sharesOutstanding * SHORT_BORROWABLE_FLOAT_FRACTION);
  let lendable = 0;
  let sawAgentInventory = false;
  for (const t of Object.values(world.traders)) {
    const shares = t.stockState?.positions[eq.id]?.shares ?? 0;
    if (shares <= 0) continue;
    sawAgentInventory = true;
    lendable += shares * SHORT_LENDABLE_POSITION_FRACTION;
  }
  const lendableCap = sawAgentInventory ? Math.floor(lendable) : floatCap;
  return Math.max(0, Math.min(floatCap, lendableCap) - currentShort);
}

function bidDepthForShort(world: World, eq: Equity, excludedAgentId?: TraderId): number {
  const book = world.orderBooks?.[eq.id];
  if (!book) return 0;
  let depth = 0;
  for (const bid of book.bids) {
    if (bid.agentId === excludedAgentId || bid.agentId === SYNTHETIC_MM_AGENT_ID) continue;
    depth += Math.max(0, bid.qty);
  }
  return Math.floor(depth);
}

// Immediate short capacity: borrowable shares that can also be sold into the
// live bid book right now. Used by UI quantity chips and suggestions.
export function maxShortableShares(world: World, eq: Equity, shipId?: TraderId): number {
  return Math.min(maxBorrowableShortShares(world, eq, shipId), bidDepthForShort(world, eq, shipId));
}

// Open or add to a short position. Borrows shares and immediately sells them
// at the current price. Player receives the cash (minus fee). Future cover
// re-buys the shares; profit if price falls, loss if it rises.
export function shortShares(world: World, equityId: EquityId, shares: number, shipId?: TraderId): StockTradeResult {
  const ctx = preflight(world, equityId, shares, shipId);
  if ("ok" in ctx) return ctx;
  const { eq, ship } = ctx;
  const positions = ensurePositions(ship!);
  const current = positions[equityId];
  if (current?.kind === "long") {
    return { ok: false, reason: `Currently long ${current.shares} ${eq.ticker}. Sell the long before shorting.` };
  }
  // Legacy saves may still carry synthetic-MM quotes. Player shorts now rely
  // on agent bids only, so strip stale MM bids before checking liquidity.
  cancelAgentOrders(world, equityId, SYNTHETIC_MM_AGENT_ID);

  const borrowable = maxBorrowableShortShares(world, eq, ship!.id);
  if (borrowable <= 0) {
    return { ok: false, reason: `${eq.ticker}'s lendable share pool is fully used right now.` };
  }
  if (shares > borrowable) {
    return { ok: false, reason: `Only ${borrowable} ${eq.ticker} shares are available to borrow right now.` };
  }

  const preview = previewBookCost(world, eq, "ask", shares, ship!.id);
  if (preview.fillable < shares) {
    if (preview.fillable <= 0) {
      return { ok: false, reason: `${eq.ticker} has no live bids to take a short sale right now.` };
    }
    return { ok: false, reason: `Only ${preview.fillable} ${eq.ticker} shares can be sold into live bids right now.` };
  }

  // Short aggresses against the bid side of the book (we're selling short).
  // The buyer's stockWallet funds the fill through executeAgainstBook. Here
  // we credit the player by the nominal fill sum minus broker fee.
  const exec = executeAgainstBook(world, eq, "ask", shares, ship!.id);
  if (!exec.ok) return { ok: false, reason: exec.reason };
  const realized = exec.totalCash;
  const fee = realized * BROKER_FEE_RATE;
  const net = realized - fee;
  ship!.funds += net;

  if (!current) {
    positions[equityId] = {
      equityId,
      kind: "short",
      shares: exec.filled,
      avgEntryPrice: exec.weightedAvgPrice,
      openedAt: world.tick,
    };
    recordTrade(world, ship!, eq, "open_short", exec.filled, exec.weightedAvgPrice, fee, net);
  } else {
    const totalShares = current.shares + exec.filled;
    current.avgEntryPrice = (current.avgEntryPrice * current.shares + exec.weightedAvgPrice * exec.filled) / totalShares;
    current.shares = totalShares;
    recordTrade(world, ship!, eq, "add_short", exec.filled, exec.weightedAvgPrice, fee, net);
  }
  incrementManualActions(world);
  return { ok: true, shares: exec.filled, cashFlow: net, fee };
}

// Close (or partially close) a short position. Buys back the borrowed shares
// at the current market price.
export function coverShares(
  world: World,
  equityId: EquityId,
  shares: number,
  trigger?: TriggerKind,
  shipId?: TraderId,
): StockTradeResult {
  const ctx = preflight(world, equityId, shares, shipId);
  if ("ok" in ctx) return ctx;
  const { eq, ship } = ctx;
  const positions = ensurePositions(ship!);
  const current = positions[equityId];
  if (!current || current.kind !== "short") {
    return { ok: false, reason: `No short position in ${eq.ticker}.` };
  }
  if (shares > current.shares) return { ok: false, reason: `Only ${current.shares} shares short.` };

  // Cover aggresses against the ask side (we're buying back). Preflight via
  // simulateMarketOrder so the player's funds are checked before the book is
  // mutated.
  const preview = previewBookCost(world, eq, "bid", shares, ship!.id);
  if (preview.fillable < shares) {
    return { ok: false, reason: `${eq.ticker} book has only ${preview.fillable} share${preview.fillable === 1 ? "" : "s"} on offer to cover.` };
  }
  const previewFee = preview.totalCash * BROKER_FEE_RATE;
  if (ship!.funds < preview.totalCash + previewFee) {
    return { ok: false, reason: `Need Ç${Math.round(preview.totalCash + previewFee).toLocaleString()} to cover, have Ç${Math.round(ship!.funds).toLocaleString()}.` };
  }

  const exec = executeAgainstBook(world, eq, "bid", shares, ship!.id);
  if (!exec.ok) return { ok: false, reason: exec.reason };
  const cost = exec.totalCash;
  const fee = cost * BROKER_FEE_RATE;
  const total = cost + fee;

  // Player pays cost + fee. Per-fill cash flow already ran inside
  // executeAgainstBook (treasury for MM sellers, agent funds for agent
  // sellers). Fee destroyed.
  ship!.funds -= total;

  // Realized P&L for a short: (entry price - cover price) × shares - fee.
  const realizedPnl = (current.avgEntryPrice - exec.weightedAvgPrice) * exec.filled - fee;
  let immediateCashFlow = -total;
  let settlementJobId: string | undefined;
  if (eq.kind === "station") {
    if (realizedPnl > 0) {
      const holdback = Math.min(realizedPnl, ship!.funds);
      ship!.funds -= holdback;
      immediateCashFlow -= holdback;
    }
    settlementJobId = createStationTradeSettlement(world, ship!.id, eq, "cover_short", exec.filled, realizedPnl);
  }
  current.shares -= exec.filled;
  if (current.shares <= 0.0001) delete positions[equityId];
  recordTrade(world, ship!, eq, "cover_short", exec.filled, exec.weightedAvgPrice, fee, immediateCashFlow, realizedPnl, trigger);
  // Auto-fired stop-loss / take-profit don't count as manual play.
  if (!trigger) incrementManualActions(world);
  return { ok: true, shares: exec.filled, cashFlow: immediateCashFlow, fee, realizedPnl, settlementJobId };
}

// Walk away from a position regardless of cash. Records realized P&L at the
// current mark, with a fixed walk-away penalty that bites — without it, this
// is just "free close at any time" and breaks the cover-cost mechanic. Used
// --- Phase 4: player limit orders ----------------------------------------
//
// Place a limit order that sits in the book at a specified price.
//
// BUY limits: deduct (qty × price × (1 + fee)) from ship.funds at placement.
// On fill the funds were already debited; just credit the position. On
// cancel of unfilled qty, refund the gross-plus-fee for that qty.
//
// SELL limits: reserve held shares via player.reservedShares so they can't
// be double-sold via market orders or other limits. On fill, credit
// ship.funds (qty × price × (1 − fee)) and decrement reservedShares + the
// position. On cancel, just decrement reservedShares.

export interface PlaceLimitResult {
  ok: true;
  orderId: string;
  reservedFunds?: number;   // for buy limits — what was debited
  reservedShares?: number;  // for sell limits — what was held
}
export interface PlaceLimitFailure { ok: false; reason: string }

export function placeLimitBuy(
  world: World,
  equityId: EquityId,
  shares: number,
  limitPrice: number,
  shipId?: TraderId,
): PlaceLimitResult | PlaceLimitFailure {
  if (!world.player) return { ok: false, reason: "No player." };
  if (shares <= 0 || !Number.isFinite(shares)) return { ok: false, reason: "Quantity must be positive." };
  if (limitPrice <= 0 || !Number.isFinite(limitPrice)) return { ok: false, reason: "Limit price must be positive." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const proximityReason = proximityBlockReason(world, eq, ship);
  if (proximityReason) return { ok: false, reason: proximityReason };

  const positions = ensurePositions(ship);
  const current = positions[equityId];
  if (current?.kind === "short") {
    return { ok: false, reason: `Currently short ${current.shares} ${eq.ticker}. Cover the short before going long.` };
  }
  // Float cap (long-side): outstanding minus what this ship already holds
  // long minus shares already reserved by its other open buy limits.
  const owned = current?.shares ?? 0;
  const openBuyShares = openLimitShares(world, eq.id, ship.id, "bid");
  const maxBuyable = Math.max(0, eq.sharesOutstanding - owned - openBuyShares);
  if (shares > maxBuyable) return { ok: false, reason: `Only ${maxBuyable} shares available on the float.` };

  const reservedFunds = shares * limitPrice * (1 + BROKER_FEE_RATE);
  if (ship.funds < reservedFunds) {
    return { ok: false, reason: `Need Ç${Math.round(reservedFunds).toLocaleString()}, have Ç${Math.round(ship.funds).toLocaleString()}.` };
  }

  ship.funds -= reservedFunds;
  const order = placeBookLimit(world, {
    equityId: eq.id, side: "bid", qty: shares, limitPrice, agentId: ship.id,
  });
  incrementManualActions(world);
  return { ok: true, orderId: order.id, reservedFunds };
}

export function placeLimitSell(
  world: World,
  equityId: EquityId,
  shares: number,
  limitPrice: number,
  shipId?: TraderId,
): PlaceLimitResult | PlaceLimitFailure {
  if (!world.player) return { ok: false, reason: "No player." };
  if (shares <= 0 || !Number.isFinite(shares)) return { ok: false, reason: "Quantity must be positive." };
  if (limitPrice <= 0 || !Number.isFinite(limitPrice)) return { ok: false, reason: "Limit price must be positive." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const proximityReason = proximityBlockReason(world, eq, ship);
  if (proximityReason) return { ok: false, reason: proximityReason };

  const positions = ensurePositions(ship);
  const current = positions[equityId];
  if (!current || current.kind !== "long") {
    return { ok: false, reason: `No long position in ${eq.ticker} to sell.` };
  }
  // Available shares = held − already reserved by other open sell limits.
  const reservedShares = ensureReservedShares(ship);
  const reserved = reservedShares[equityId] ?? 0;
  const available = current.shares - reserved;
  if (shares > available) {
    return { ok: false, reason: `Only ${available} unreserved share${available === 1 ? "" : "s"} of ${eq.ticker}.` };
  }

  reservedShares[equityId] = reserved + shares;

  const order = placeBookLimit(world, {
    equityId: eq.id, side: "ask", qty: shares, limitPrice, agentId: ship.id,
  });
  incrementManualActions(world);
  return { ok: true, orderId: order.id, reservedShares: shares };
}

// Atomic cancel+replace of an open player limit order. Allows the player
// to change qty and/or price on a resting order in a single op (so funds
// or shares get released and re-reserved without a window where the order
// is gone). Returns the new order id (different from the cancelled one).
export function adjustPlayerLimit(
  world: World,
  equityId: EquityId,
  orderId: string,
  newQty: number,
  newPrice: number,
  shipId?: TraderId,
): { ok: true; orderId: string } | { ok: false; reason: string } {
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const book = world.orderBooks?.[equityId];
  if (!book) return { ok: false, reason: "No book for that equity." };
  const order = [...book.bids, ...book.asks].find(o => o.id === orderId && o.agentId === ship.id);
  if (!order) return { ok: false, reason: "Order not found (already filled or cancelled)." };

  const cancelResult = cancelPlayerLimit(world, equityId, orderId, shipId);
  if (!cancelResult.ok) return cancelResult;

  const placeResult = order.side === "bid"
    ? placeLimitBuy(world, equityId, newQty, newPrice, shipId)
    : placeLimitSell(world, equityId, newQty, newPrice, shipId);
  if (!placeResult.ok) {
    // Re-place the original on failure so we don't leave the player worse off.
    if (order.side === "bid") placeLimitBuy(world, equityId, order.qty, order.limitPrice, shipId);
    else placeLimitSell(world, equityId, order.qty, order.limitPrice, shipId);
    return { ok: false, reason: placeResult.reason };
  }
  return { ok: true, orderId: placeResult.orderId };
}

// Cancel an open player limit order. Refunds the unfilled portion of
// reserved funds (for buy limits) or shares (for sell limits).
export function cancelPlayerLimit(world: World, equityId: EquityId, orderId: string, shipId?: TraderId): { ok: true; refunded: number } | { ok: false; reason: string } {
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const book = world.orderBooks?.[equityId];
  if (!book) return { ok: false, reason: "No book for that equity." };
  const order = [...book.bids, ...book.asks].find(o => o.id === orderId && o.agentId === ship.id);
  if (!order) return { ok: false, reason: "Order not found (already filled or cancelled)." };

  let refunded = 0;
  if (order.side === "bid") {
    refunded = order.qty * order.limitPrice * (1 + BROKER_FEE_RATE);
    ship.funds += refunded;
  } else {
    refunded = order.qty;
    const reservedShares = ensureReservedShares(ship);
    reservedShares[equityId] = Math.max(0, (reservedShares[equityId] ?? 0) - order.qty);
  }
  cancelBookOrder(world, equityId, orderId);
  return { ok: true, refunded };
}

export interface PlayerLimitView {
  orderId: string;
  equityId: EquityId;
  ticker: string;
  side: "bid" | "ask";
  qty: number;
  limitPrice: number;
  postedAt: number;
}

export function listPlayerLimits(world: World, shipId?: TraderId): PlayerLimitView[] {
  const ship = getPlayerShip(world, shipId);
  if (!ship || !world.orderBooks) return [];
  const out: PlayerLimitView[] = [];
  for (const eqId of Object.keys(world.orderBooks)) {
    const eq = world.equities[eqId];
    if (!eq) continue;
    const book = world.orderBooks[eqId];
    for (const o of [...book.bids, ...book.asks]) {
      if (o.agentId !== ship.id) continue;
      out.push({
        orderId: o.id,
        equityId: eqId,
        ticker: eq.ticker,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limitPrice,
        postedAt: o.postedAt,
      });
    }
  }
  return out;
}

function openLimitShares(world: World, equityId: EquityId, shipId: TraderId, side: "bid" | "ask"): number {
  const book = world.orderBooks?.[equityId];
  if (!book) return 0;
  const list = side === "bid" ? book.bids : book.asks;
  let total = 0;
  for (const o of list) if (o.agentId === shipId) total += o.qty;
  return total;
}

// as the escape hatch for shorts the player can't afford to buy back, and
// for longs they want to dump cleanly. The position vanishes; lender / buyer
// is notionally absorbed by the equity's underlying.
export const ABANDON_PENALTY_RATE = 0.05;     // 5% extra hit on top of mark-to-market

export function abandonPosition(world: World, equityId: EquityId, trigger?: TriggerKind, shipId?: TraderId): StockTradeResult {
  if (!world.player) return { ok: false, reason: "No player." };
  const eq = world.equities[equityId];
  if (!eq) return { ok: false, reason: "Equity not listed." };
  const ship = getPlayerShip(world, shipId);
  if (!ship) return { ok: false, reason: "No anchor ship." };
  const positions = ensurePositions(ship);
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
    ship,
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
export function setStopLoss(world: World, equityId: EquityId, price: number | null, shipId?: TraderId): { ok: true } | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  const ship = getPlayerShip(world, shipId);
  const pos = ship?.stockPositions?.[equityId];
  if (!pos) return { ok: false, reason: "No position to attach a stop to." };
  if (price == null) { delete pos.stopLoss; return { ok: true }; }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "Stop price must be positive." };
  // Sanity: a long stop-loss above current price would fire instantly. Allow
  // it (player may want exit-now), but reject obvious mistakes that put the
  // stop on the wrong side of profit logic.
  pos.stopLoss = price;
  return { ok: true };
}

export function setTakeProfit(world: World, equityId: EquityId, price: number | null, shipId?: TraderId): { ok: true } | { ok: false; reason: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  const ship = getPlayerShip(world, shipId);
  const pos = ship?.stockPositions?.[equityId];
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
  if (!world.player) return;
  // Snapshot so we can mutate each ship's positions map during iteration.
  for (const shipId of world.player.shipIds) {
    const ship = world.traders[shipId];
    if (!ship?.stockPositions) continue;
    for (const eqId of Object.keys(ship.stockPositions)) {
      const pos = ship.stockPositions[eqId];
      if (!pos) continue;
      const eq = world.equities[eqId];
      if (!eq) continue;
      const trigger = triggerHit(pos, eq.price);
      if (!trigger) continue;
      // Long → sell; short → cover. Fall back to abandon if the close path
      // can't execute (e.g. treasury broke, player broke).
      let result: StockTradeResult;
      if (pos.kind === "long") {
        result = sellShares(world, eqId, pos.shares, trigger, shipId);
        if (!result.ok && shouldAbandonAfterTriggerMiss(result.reason)) result = abandonPosition(world, eqId, trigger, shipId);
      } else {
        result = coverShares(world, eqId, pos.shares, trigger, shipId);
        if (!result.ok && shouldAbandonAfterTriggerMiss(result.reason)) result = abandonPosition(world, eqId, trigger, shipId);
      }
      void result;
    }
  }
}

function shouldAbandonAfterTriggerMiss(reason: string): boolean {
  if (reason === "Trade only while docked.") return false;
  if (reason.startsWith("Move within ")) return false;
  return true;
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
  // Each ship pays its own borrow fees from its own wallet — fees are
  // assessed per ship per open short.
  for (const shipId of world.player.shipIds) {
    const ship = world.traders[shipId];
    if (!ship?.stockPositions) continue;
    let totalFee = 0;
    for (const pos of Object.values(ship.stockPositions)) {
      if (pos.kind !== "short") continue;
      const eq = world.equities[pos.equityId];
      if (!eq) continue;
      const notional = pos.shares * eq.price;
      totalFee += notional * SHORT_BORROW_RATE_PER_TICK;
    }
    if (totalFee <= 0) continue;
    ship.funds = Math.max(0, ship.funds - totalFee);
  }
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

// Aggregate across all player ships, or scope to a single ship via shipId.
// "Only achievements are shared" — positions, trades, and futures all live
// on each ship, so callers that want a fleet-wide view (TopBar totals, the
// Exchange tape) walk every ship; per-ship views pass the selected id.
export function listPositions(world: World, shipId?: TraderId): StockPosition[] {
  if (!world.player) return [];
  const ids = shipId ? [shipId] : world.player.shipIds;
  const out: StockPosition[] = [];
  for (const id of ids) {
    const ship = world.traders[id];
    if (!ship?.stockPositions) continue;
    out.push(...Object.values(ship.stockPositions));
  }
  return out;
}

export function listTradeRecords(world: World, limit = TRADE_LEDGER_MAX, shipId?: TraderId): TradeRecord[] {
  if (!world.player) return [];
  const ids = shipId ? [shipId] : world.player.shipIds;
  const out: TradeRecord[] = [];
  for (const id of ids) {
    const ship = world.traders[id];
    if (!ship?.stockTrades) continue;
    out.push(...ship.stockTrades);
  }
  out.sort((a, b) => a.tick - b.tick);
  return out.slice(-limit).reverse();
}

// --- internal cash routing ------------------------------------------------

function routeShareCashFlow(world: World, eq: Equity, amount: number): void {
  if (amount <= 0) return;
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    if (market) depositToTreasury(market, amount);
    return;
  }
  if (eq.kind === "syndicate") {
    const synd = world.syndicates[eq.underlyingId];
    if (synd) synd.treasury += amount;
    return;
  }
  // C-1/C-2: commodity + basis have no underlying treasury — this path
  // is only reached when the dormant MM is a counterparty, which doesn't
  // happen in practice. No-op.
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
  if (eq.kind === "syndicate") {
    const synd = world.syndicates[eq.underlyingId];
    if (!synd) return 0;
    const paid = Math.max(0, Math.min(amount, synd.treasury));
    synd.treasury -= paid;
    return paid;
  }
  // C-1/C-2: commodity + basis have no treasury. Same as
  // routeShareCashFlow above — dormant MM-counterparty path; no-op.
  return 0;
}

// --- per-tick stock-market step --------------------------------------------

export function tickStockMarket(world: World): void {
  if (Object.keys(world.equities).length === 0) return;   // no market initialized

  // Expire old agent quotes before anyone refreshes. Previously TTL was set
  // but never decremented after the synthetic-MM phase was removed, which
  // let stale quotes linger if an agent stopped trading.
  for (const eq of Object.values(world.equities)) {
    ageOrders(ensureOrderBook(world, eq.id));
  }

  // Agent order-book step. Agents run first, staggered by id hash so the
  // whole market does not re-quote on the same tick. Their orders join
  // whatever is left in the book from prior ticks.
  stepStockAgents(world);
  for (const eq of Object.values(world.equities)) {
    const matched = matchBook(ensureOrderBook(world, eq.id), world.tick);
    if (matched.length === 0) continue;
    // Limit-order crosses during tick: settle BOTH sides. Non-player sides
    // (MM treasury / agent stockWallet + position) handled first; then any
    // player limit-order fills get player-side bookkeeping (funds were
    // debited at placement for buys; reservedShares decrements; etc.).
    settleAllNonPlayerSides(world, eq, matched);
    settlePlayerLimitFills(world, eq, matched);
    recordRecentTrades(eq, matched);
    // eq.price snaps to the last matched trade's price.
    const last = matched[matched.length - 1];
    eq.prevPrice = eq.price;
    eq.price = clampSharePrice(eq, last.price);
  }

  // EMA toward fundamental — fallback movement when no trades printed this
  // tick. When a player trade ran between ticks, eq.price was updated to the
  // last fill, so the EMA blends from there toward fundamental.
  for (const eq of Object.values(world.equities)) {
    recomputeEquityPrice(world, eq);
  }
  // Trigger checks immediately after the price update so stops fire on the
  // freshest tick. Borrow fees + dividends still settle on whatever's left.
  checkPositionTriggers(world);
  decaySyndicateRevenue(world);
  tickShortBorrowFees(world);
  payoutDividends(world);
  // C-3: futures mark-to-market + expiry settlement.
  tickFutures(world);
}

// --- queries --------------------------------------------------------------

export function listEquities(world: World): Equity[] {
  return Object.values(world.equities).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function portfolioValue(world: World, shipId?: TraderId): number {
  // Long-position market value across player ships. Returns the long-side
  // market value only — the more honest "equity value" view shows long
  // market value and tracks short P&L separately.
  let v = 0;
  for (const pos of listPositions(world, shipId)) {
    const eq = world.equities[pos.equityId];
    if (!eq) continue;
    if (pos.kind === "long") v += eq.price * pos.shares;
  }
  return v;
}

// Total unrealized P&L across all open positions, fleet-wide by default.
export function totalUnrealizedPnl(world: World, shipId?: TraderId): number {
  let pnl = 0;
  for (const pos of listPositions(world, shipId)) pnl += unrealizedPnl(world, pos);
  return pnl;
}

export function priceChangePct(eq: Equity): number {
  if (eq.prevPrice == null || eq.prevPrice === 0) return 0;
  return (eq.price - eq.prevPrice) / eq.prevPrice;
}
