import type { CargoLot, FuelType, GoodId, JobId, LocationId, ShipUpgradeSlots, Trader, TraderEvent, UpgradeSlot, World } from "./types";
import { distance as legDistance, findRoutePath, pathDistance, reachableNeighbors, routeDistance } from "./geometry";
import { marketQuote, priceFor } from "./pricing";
import {
  chargeDockingFee,
  DOCKING_FEE_PER_CAPACITY,
  MAINTENANCE_PER_CAPACITY,
  SALES_TAX_RATE,
  treasuryHealthMultiplier,
  settlePurchase,
  settleSale,
  withdrawFromTreasury,
} from "./economy";
import { acceptJob, collectTradeJob, creditJobOnDelivery, type JobCompletionEvent } from "./jobs";
import {
  bumpPlayerReputation,
  creditActivity,
  effectiveToll,
  NPC_DOCK_NUDGE,
  NPC_TRADE_PER_CREDIT,
  PLAYER_DOCK_NUDGE,
  PLAYER_TRADE_PER_CREDIT,
  REP_PER_FOREIGN_CREDIT,
  REP_PER_FOREIGN_DOCK,
  territoryBuyBonus,
  territorySellBonus,
  tollForArrival,
} from "./control";
import { noteSyndicateRevenue } from "./stock";
import { pushNote, pushShipLog, pushTraderEvent } from "./log";
import {
  autopilotPolicy as encounterAutopilotPolicy,
  maybeSpawnEncounter,
  recordEncounter,
  resolveEncounter,
} from "./combat/encounters";
import { encounterLogMessage, encounterLogTone } from "./combat/log";
import { DEV_MODE } from "../ui/devMode";
import {
  buyDiscountFraction,
  combinedShipModifiers,
  effectivePerDistance,
  hasCrew,
  ignoresFuel,
  MAINTENANCE_DEBT_TRAVEL_BLOCK,
  recomputeShipStats,
  sellPremiumFraction,
  travelTicksFor,
} from "./crew";
import { firstEmptyWeaponSlot, isUpgradeGood, upgradeDef } from "./upgrades";
import { buildDestinationLoadoutPlans, buildLocalFetchPlans, type PlannedBuy, type RoutePlanCandidate } from "./loadoutPlans";
import { incrementManualActions, isMilestoneMet, upgradeTierMilestone, MILESTONES, MILESTONE_LABELS } from "./milestones";

export const MIN_PROFIT_PER_TICK = 0.05;
export const MAX_DRAW_FRACTION = 0.5;
export const REFUEL_THRESHOLD = 0.6;          // refuel earlier — was 0.4
export const STRANDING_RESERVE = 0.3;         // require 30% reserve at arrival — was 0.2
export const INFLIGHT_WEIGHT = 1.0;
export const MAX_NO_OPPORTUNITY_TICKS = 12;
export const NPC_OPERATING_FLOAT = 5_000;
// All sells (auto-arrival, NPC arrival, manual click) drip cargo into the
// destination market across this many ticks instead of dumping it in one.
// Each tick settles 1/N of every remaining lot in `unloadingCargo`, so stock
// and treasury impact spread out and price EMAs don't see a cliff.
export const UNLOAD_TICKS = 4;

// Cargo + unloadingCargo both physically occupy the hold and count toward
// capacity until the drip removes them.
export function totalCargoMass(trader: Trader, world: World): number {
  let m = 0;
  for (const l of trader.cargo) m += l.qty * (world.goods[l.good]?.weight ?? 0);
  for (const l of trader.unloadingCargo ?? []) m += l.qty * (world.goods[l.good]?.weight ?? 0);
  return m;
}

export function isUnloading(trader: Trader): boolean {
  return (trader.unloadingCargo?.length ?? 0) > 0;
}

function unloadTicksFor(trader: Trader): number {
  const mods = combinedShipModifiers(trader);
  if ((mods.instantUnload ?? 0) >= 1) return 0;
  const speedBonus = Math.max(0, mods.unloadSpeedBonus ?? 0);
  return Math.max(1, Math.round(UNLOAD_TICKS / (1 + speedBonus)));
}

function fuelPerDistanceFor(trader: Trader, ft: FuelType | null): number {
  if (ignoresFuel(trader)) return 0;
  return ft ? effectivePerDistance(trader, ft.perDistance) : Infinity;
}

function fuelQtyForPlanning(trader: Trader, fuel: Trader["currentFuel"], isHypothetical = false): number {
  if (ignoresFuel(trader)) return Infinity;
  return isHypothetical ? trader.fuelCapacity : fuel?.qty ?? 0;
}

function burnTravelFuel(trader: Trader, fuelNeeded: number): void {
  if (fuelNeeded <= 0.001) return;
  if (!trader.currentFuel) return;
  trader.currentFuel = {
    good: trader.currentFuel.good,
    qty: Math.max(0, trader.currentFuel.qty - fuelNeeded),
  };
}

// Max remaining ticks across all unloading lots — used by the UI to show a
// single progress bar per good even when multiple lots of the same good are
// dripping at different stages (e.g. successive Sell clicks).
export function unloadTicksRemainingFor(trader: Trader, good?: GoodId): number {
  let max = 0;
  for (const lot of trader.unloadingCargo ?? []) {
    if (good != null && lot.good !== good) continue;
    const t = lot.unloadTicksRemaining ?? 0;
    if (t > max) max = t;
  }
  return max;
}

// Re-exported for back-compat with consumers that imported it from here.
export type { TraderEvent };

export interface TradeOption {
  good: GoodId;
  to: LocationId;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  travelTicks: number;
  fuelNeeded: number;
  totalProfit: number;
  profitPerTick: number;
  jobId?: JobId;
  jobAccepted?: boolean;
  jobBonus?: number;
}

export function activeFuelType(trader: Trader): FuelType | null {
  if (!trader.currentFuel) return null;
  return trader.fuelTypes.find(f => f.good === trader.currentFuel!.good) ?? null;
}

export function selectRefuelType(world: World, trader: Trader): FuelType | null {
  const market = world.markets[trader.location];
  for (const ft of trader.fuelTypes) {
    if ((market.stock[ft.good] ?? 0) > 0) return ft;
  }
  return null;
}

function tryRefuel(world: World, trader: Trader, events: TraderEvent[]): void {
  if (ignoresFuel(trader)) return;
  const tankFraction = (trader.currentFuel?.qty ?? 0) / trader.fuelCapacity;
  if (tankFraction >= REFUEL_THRESHOLD) return;

  const choice = selectRefuelType(world, trader);
  if (!choice) return;

  const market = world.markets[trader.location];
  const stock = market.stock[choice.good];
  const price = market.prices[choice.good];

  const switching = !trader.currentFuel || trader.currentFuel.good !== choice.good;
  const currentQty = switching ? 0 : trader.currentFuel!.qty;

  const need = trader.fuelCapacity - currentQty;
  // Emergency credit: when an NPC is broke + stuck or has been idle a long
  // stretch, the local treasury underwrites a top-off so they can rejoin the
  // economy. Closes the loop: bailout funds come from the city, not nowhere.
  const emergencyCredit = !isPlayerShip(world, trader)
    && (isStuck(world, trader) || (trader.noOpportunityTicks ?? 0) >= MAX_NO_OPPORTUNITY_TICKS);
  const affordable = emergencyCredit ? Infinity : price > 0 ? trader.funds / price : 0;
  const buyQty = Math.min(need, stock, affordable);
  if (buyQty <= 0.001) return;

  market.stock[choice.good] = stock - buyQty;
  const cost = buyQty * price;
  if (emergencyCredit && trader.funds < cost) {
    // City underwrites the gap. Trader pays what they can (down to 0); the
    // remainder is drawn from the treasury, capped at the treasury floor —
    // closed loop, no money creation. If the city is broke too, the partial
    // refuel still happens for what the trader could afford.
    const traderShare = trader.funds;
    const bridgeWanted = cost - traderShare;
    const bridgeAvailable = withdrawFromTreasury(market, bridgeWanted);
    settlePurchase(market, price, traderShare / Math.max(price, 0.0001));
    trader.funds = 0;
    // Note: the city pays the supplier (the deposit) the part it covered.
    // Net effect on treasury = +traderShare (deposit) - bridgeAvailable.
    if (bridgeAvailable < bridgeWanted) {
      // City couldn't cover the full bridge. Refund the unfunded portion
      // back to stock (we can't fuel air).
      const unfunded = bridgeWanted - bridgeAvailable;
      const unfundedQty = unfunded / Math.max(price, 0.0001);
      market.stock[choice.good] = (market.stock[choice.good] ?? 0) + unfundedQty;
      const finalQty = buyQty - unfundedQty;
      trader.currentFuel = { good: choice.good, qty: currentQty + finalQty };
      if (finalQty > 0.001) events.push({ trader: trader.id, kind: "refuel", good: choice.good, qty: finalQty, unitPrice: price });
      return;
    }
  } else {
    trader.funds = Math.max(0, trader.funds - cost);
    settlePurchase(market, price, buyQty);
  }
  trader.currentFuel = { good: choice.good, qty: currentQty + buyQty };

  events.push({ trader: trader.id, kind: "refuel", good: choice.good, qty: buyQty, unitPrice: price });
}

function isPlayerShip(world: World, trader: Trader): boolean {
  return world.player?.shipIds.includes(trader.id) ?? false;
}

export function maintenanceTravelBlockReason(trader: Trader): string | null {
  const debt = trader.maintenanceDebt ?? 0;
  if (debt < MAINTENANCE_DEBT_TRAVEL_BLOCK) return null;
  return `Maintenance debt Ç${Math.round(debt).toLocaleString()} too high — repair ship before travel.`;
}

function canUseContractCargoPlanning(world: World, trader: Trader): boolean {
  return isPlayerShip(world, trader)
    && (trader.pilot === "manual" || (trader.pilot === "auto" && hasCrew(trader, "captain")));
}

function playerDrawFraction(world: World, trader: Trader): number | undefined {
  return isPlayerShip(world, trader) ? 1.0 : undefined;
}

function restoreNpcOperatingFloat(world: World, trader: Trader): void {
  if (isPlayerShip(world, trader)) return;
  if (trader.cargo.length > 0) return;
  if ((trader.noOpportunityTicks ?? 0) < MAX_NO_OPPORTUNITY_TICKS) return;
  if (trader.funds >= NPC_OPERATING_FLOAT) return;
  // Closed-loop bailout: top up from the local treasury when possible. If
  // the local treasury is below the haircut threshold, fall back to a smaller
  // grant — even cities running deficits can write a courtesy check to keep
  // the local trade flow alive. Money comes from the city's debt, not nowhere.
  const market = world.markets[trader.location];
  if (!market) return;
  const want = NPC_OPERATING_FLOAT - trader.funds;
  const grant = withdrawFromTreasury(market, want);
  if (grant > 0) trader.funds += grant;
}

type RouteJobBonus = {
  jobId: JobId;
  perUnit: number;
  remaining: number;
  accepted: boolean;
  tierRank: number;
  expiresAt: number;
};

const JOB_TIER_RANK = { high: 0, medium: 1, low: 2 } as const;

function addRouteJobBonus(
  map: Map<string, RouteJobBonus[]>,
  key: string,
  entry: RouteJobBonus,
): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

function scoreRouteJobBonus(
  entries: RouteJobBonus[] | undefined,
  qty: number,
): { total: number; jobId?: JobId; jobAccepted?: boolean } {
  if (!entries || qty <= 0) return { total: 0 };
  const sorted = [...entries].sort((a, b) =>
    Number(b.accepted) - Number(a.accepted)
    || a.tierRank - b.tierRank
    || a.expiresAt - b.expiresAt,
  );
  let remainingQty = qty;
  let total = 0;
  let jobId: JobId | undefined;
  let jobAccepted: boolean | undefined;
  for (const entry of sorted) {
    if (remainingQty <= 0) break;
    const credited = Math.min(remainingQty, entry.remaining);
    if (credited <= 0) continue;
    total += credited * entry.perUnit;
    remainingQty -= credited;
    jobId ??= entry.jobId;
    jobAccepted ??= entry.accepted;
  }
  return { total, jobId, jobAccepted };
}

function inTransitArrivalsByDestGood(world: World): Map<string, number> {
  const acc = new Map<string, number>();
  for (const t of Object.values(world.traders)) {
    if (t.state !== "transit" || !t.destination) continue;
    for (const lot of t.cargo) {
      const key = `${t.destination}|${lot.good}`;
      acc.set(key, (acc.get(key) ?? 0) + lot.qty);
    }
  }
  return acc;
}

function settleUnloadedCargo(world: World, trader: Trader, lot: CargoLot, qty: number, events: TraderEvent[]): void {
  const dstMarket = world.markets[trader.location];
  // Apply the trader's sellPremium upgrade plus the own-territory
  // bonus when applicable — pay-out is sourced from the station's
  // treasury (settleSale clamps to what's available), so the float
  // stays conserved. Combined cap of 0.5 mirrors the upgrade-only path.
  const totalSellPremium = Math.min(0.5, sellPremiumFraction(trader) + territorySellBonus(world, trader));
  const unitPrice = marketQuote(world, trader.location, lot.good) * (1 + totalSellPremium);
  dstMarket.stock[lot.good] = (dstMarket.stock[lot.good] ?? 0) + qty;
  const settlement = settleSale(dstMarket, unitPrice, qty);
  trader.funds += settlement.traderRevenue;
  noteSyndicateRevenue(world, trader.id, settlement.traderRevenue);
  // Drip-aggregated path: when the lot tracks unloadOriginalQty, we
  // accumulate proceeds and only emit a single sell event when the lot
  // fully drains (handled by the caller). Otherwise (instant unload)
  // emit one event per call as before.
  if (lot.unloadOriginalQty != null) {
    lot.unloadProceedsSum = (lot.unloadProceedsSum ?? 0) + settlement.traderRevenue;
  } else {
    events.push({ trader: trader.id, kind: "sell", good: lot.good, qty, unitPrice: settlement.effectiveUnitPrice, to: trader.location });
  }
  creditJobOnDelivery(world, trader.id, trader.location, lot.good, qty);
  // Selling cargo at a station counts as activity by the trader's
  // syndicate — bumps territory control by trade volume. Player sells
  // at a foreign station also accrue reputation with that station's
  // owner.
  const isPlayer = isPlayerShip(world, trader);
  const sellRate = isPlayer ? PLAYER_TRADE_PER_CREDIT : NPC_TRADE_PER_CREDIT;
  creditActivity(world, trader, trader.location, settlement.traderRevenue * sellRate);
  if (isPlayer) {
    const stationFaction = world.locations[trader.location]?.traits.faction;
    if (stationFaction && stationFaction !== trader.syndicateId) {
      bumpPlayerReputation(world, stationFaction, settlement.traderRevenue * REP_PER_FOREIGN_CREDIT);
    }
  }
}

function beginUnloadLots(world: World, trader: Trader, lots: CargoLot[], events: TraderEvent[]): void {
  if (lots.length === 0) return;
  const ticks = unloadTicksFor(trader);
  if (ticks <= 0) {
    for (const lot of lots) settleUnloadedCargo(world, trader, lot, lot.qty, events);
    return;
  }
  // Snapshot the lot's original qty so we can emit ONE summary "sold N
  // at avg Ç" event once the drip completes, instead of one per drip
  // tick (which would round to "Sold 0" for fractional drip amounts).
  const movedLots = lots.map(l => ({ ...l, unloadTicksRemaining: ticks, unloadOriginalQty: l.qty, unloadProceedsSum: 0 }));
  trader.unloadingCargo = [...(trader.unloadingCargo ?? []), ...movedLots];
}

export function listTradeOptions(
  world: World,
  trader: Trader,
  inflight?: Map<string, number>,
  drawFraction: number = MAX_DRAW_FRACTION,
  fromLocation?: LocationId,
): TradeOption[] {
  if (maintenanceTravelBlockReason(trader)) return [];

  const inflightMap = inflight ?? inTransitArrivalsByDestGood(world);
  const here = fromLocation ?? trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  if ((!fuel || !ft) && !fuelFree) return [];
  const fuelGood = fuel?.good ?? ft?.good;
  const localFuelPrice = fuelGood ? srcMarket.prices[fuelGood] ?? 0 : 0;
  // When evaluating from a hypothetical location (speculative travel),
  // assume the ship refueled at that location (fuel = capacity).
  const isHypothetical = fromLocation != null && fromLocation !== trader.location;
  const effectiveFuel = fuelQtyForPlanning(trader, fuel, isHypothetical);
  const options: TradeOption[] = [];

  // Pre-index this trader's accepted contracts by (destination|good) → bonus
  // info. Routes that match an accepted job get the per-unit reward credited
  // on top of the trade profit, so the auto-pilot prefers them when picking
  // the next move (and follows through on contracts it has signed up for).
  //
  // For player ships in manual mode (where the engine runs as a hint) and
  // auto+pilot (where the pilot auto-accepts on arrival), also fold
  // in unaccepted shortage contracts at the destination. This makes the
  // engine actively chase contract-aligned trades instead of stumbling onto
  // them.
  const willRealizeUnaccepted = canUseContractCargoPlanning(world, trader);
  const jobBonusMap = new Map<string, RouteJobBonus[]>();
  for (const j of Object.values(world.jobs)) {
    if (j.kind === "trade" || !j.good) continue;
    if (j.acceptedBy === trader.id) {
      const remaining = j.qty - j.delivered;
      if (remaining <= 0) continue;
      // Accepted contracts: include penalty-avoided in the bonus. The player
      // owes that money if the contract expires unfilled, so completing it
      // is worth reward + penalty, not just reward. Steers the engine to
      // follow through on commitments instead of getting distracted.
      const perUnit = (j.reward + j.penalty) / j.qty;
      addRouteJobBonus(jobBonusMap, `${j.destination}|${j.good}`, {
        jobId: j.id,
        perUnit,
        remaining,
        accepted: true,
        tierRank: JOB_TIER_RANK[j.tier],
        expiresAt: j.expiresAt,
      });
    } else if (j.acceptedBy == null && j.kind === "shortage" && willRealizeUnaccepted) {
      // Unaccepted: just reward — no commitment cost yet.
      addRouteJobBonus(jobBonusMap, `${j.destination}|${j.good}`, {
        jobId: j.id,
        perUnit: j.reward / j.qty,
        remaining: j.qty,
        accepted: false,
        tierRank: JOB_TIER_RANK[j.tier],
        expiresAt: j.expiresAt,
      });
    }
  }

  // Cargo space available for new buys = capacity - existing lot mass.
  // Lets the suggestion engine recommend "hedge" buys when the player has
  // partial cargo — without this, every buy was sized to full empty bay.
  // unloadingCargo also counts: it's still physically aboard until drip removes it.
  const usedMass = totalCargoMass(trader, world);
  const freeMass = Math.max(0, trader.capacity - usedMass);
  const destinations = reachableNeighbors(world, here);

  // Pre-compute reserved cargo mass for accepted contracts, indexed by
  // destination. When evaluating a route to D, the player's primary buy
  // shouldn't gobble cargo that's needed for contract goods bound for D
  // and available right here. Otherwise the engine recommends "max bay"
  // and crowds out the contract goods the player came here for.
  const reservedMassByDest = new Map<LocationId, Map<GoodId, number>>();
  if (canUseContractCargoPlanning(world, trader)) {
    for (const j of Object.values(world.jobs)) {
      if (j.kind === "trade" || !j.good) continue;
      if (j.acceptedBy !== trader.id) continue;
      const remaining = j.qty - j.delivered;
      if (remaining <= 0) continue;
      const goodObj = world.goods[j.good]; if (!goodObj) continue;
      const stockHere = srcMarket.stock[j.good] ?? 0;
      const reserveQty = Math.min(remaining, Math.floor(stockHere));
      if (reserveQty < 1) continue;
      const reserveMass = reserveQty * goodObj.weight;
      let inner = reservedMassByDest.get(j.destination);
      if (!inner) { inner = new Map(); reservedMassByDest.set(j.destination, inner); }
      inner.set(j.good, reserveMass);
    }
  }

  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    if (isUpgradeGood(goodId)) continue;
    const good = world.goods[goodId];
    const buyPrice = marketQuote(world, here, goodId);
    const srcStock = srcMarket.stock[goodId] ?? 0;

    const perDist = fuelPerDistanceFor(trader, ft);
    for (const { to: dstId, dist } of destinations) {

      // Reserve cargo for accepted contracts at this destination whose good
      // isn't this primary good. The reservation only counts what's actually
      // available at the source — no point reserving for goods you can't buy.
      let reservedMass = 0;
      const innerReserve = reservedMassByDest.get(dstId);
      if (innerReserve) {
        for (const [reservedGood, mass] of innerReserve) {
          if (reservedGood === goodId) continue;
          reservedMass += mass;
        }
      }
      const usableMass = Math.max(0, freeMass - reservedMass);

      const maxByCargo = usableMass / good.weight;
      const maxByStock = srcStock * drawFraction;
      const maxByFunds = buyPrice > 0 ? trader.funds / buyPrice : 0;
      const maxQty = Math.floor(Math.min(maxByCargo, maxByStock, maxByFunds));
      if (maxQty <= 0) continue;

      const fuelNeeded = dist * perDist;
      if (fuelNeeded > effectiveFuel) continue;

      const dstMarket = world.markets[dstId];
      const fuelAfter = fuelFree ? trader.fuelCapacity : effectiveFuel - fuelNeeded;
      const deliversCompatibleFuel = trader.fuelTypes.some(f => f.good === goodId);
      const dstHasMyFuel = fuelFree || trader.fuelTypes.some(
        f => ((dstMarket.stock[f.good] ?? 0) + (f.good === goodId ? maxQty : 0)) >= trader.fuelCapacity * REFUEL_THRESHOLD,
      );
      const safeReserve = fuelFree || fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
      if (!dstHasMyFuel && !safeReserve && !deliversCompatibleFuel) continue;

      const dst = world.locations[dstId];
      const dstTarget = dst.targetStock[goodId] ?? 0;
      const dstStockNow = dstMarket.stock[goodId] ?? 0;
      const inflightToDst = inflightMap.get(`${dstId}|${goodId}`) ?? 0;
      const dstStockAtArrival = dstStockNow + INFLIGHT_WEIGHT * inflightToDst;
      const grossSellPrice = dstTarget > 0
        ? priceFor(world.goods[goodId].basePrice, dstStockAtArrival, dstTarget)
        : marketQuote(world, dstId, goodId);
      // Treasury haircut: a city short on treasury can't pay full price. The
      // trader factors in this haircut when scoring routes. Without this, they
      // would happily sail into a depleted treasury and lose money.
      const dstTreasuryMult = treasuryHealthMultiplier(dstMarket);
      const sellPrice = grossSellPrice * dstTreasuryMult * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * localFuelPrice;
      const grossProfitPerUnit = sellPrice - buyPrice - fuelCost / maxQty;
      if (grossProfitPerUnit <= 0) continue;

      const travelTicks = travelTicksFor(trader, dist);
      const tripMaintenance = travelTicks * trader.capacity * MAINTENANCE_PER_CAPACITY;
      const tripDockingFee = trader.capacity * DOCKING_FEE_PER_CAPACITY;
      let totalProfit = grossProfitPerUnit * maxQty - tripMaintenance - tripDockingFee;
      // Layer in any matching contract bonus for this trader.
      const jobBonus = scoreRouteJobBonus(jobBonusMap.get(`${dstId}|${goodId}`), maxQty);
      totalProfit += jobBonus.total;
      if (totalProfit <= 0) continue;
      const profitPerTick = totalProfit / (travelTicks + 1);
      if (profitPerTick < MIN_PROFIT_PER_TICK) continue;

      options.push({
        good: goodId,
        to: dstId,
        qty: maxQty,
        buyPrice,
        sellPrice,
        travelTicks,
        fuelNeeded,
        totalProfit,
        profitPerTick,
        jobId: jobBonus.jobId,
        jobAccepted: jobBonus.jobAccepted,
        jobBonus: jobBonus.total,
      });
    }
  }

  options.sort((a, b) => b.profitPerTick - a.profitPerTick);
  return options;
}

function evaluateOptions(world: World, trader: Trader, inflight: Map<string, number>): TradeOption | null {
  const opts = listTradeOptions(world, trader, inflight, playerDrawFraction(world, trader));
  return opts[0] ?? null;
}

function canExecuteLoadoutPlans(world: World, trader: Trader): boolean {
  return isPlayerShip(world, trader)
    && trader.pilot === "auto"
    && hasCrew(trader, "captain");
}

function bestAutoLoadoutPlan(world: World, trader: Trader): RoutePlanCandidate | null {
  if (!canExecuteLoadoutPlans(world, trader)) return null;
  const drawFraction = playerDrawFraction(world, trader) ?? MAX_DRAW_FRACTION;
  const plans = [
    ...buildDestinationLoadoutPlans(world, trader, drawFraction),
    ...buildLocalFetchPlans(world, trader),
  ];
  plans.sort((a, b) =>
    b.value - a.value
    || b.buys.length - a.buys.length
    || a.dst.localeCompare(b.dst),
  );
  return plans[0] ?? null;
}

export interface SpeculativeOption {
  via: LocationId;          // where to fly empty to
  thenBuy: GoodId;          // best good to buy at via
  thenSellAt: LocationId;   // where to sell after
  qty: number;
  emptyTravelTicks: number; // ticks to fly empty to via
  emptyFuelNeeded: number;
  totalTicks: number;       // emptyTravel + tradeTravel + 1
  netProfit: number;        // best trade total - empty trip costs
  profitPerTick: number;
}

interface RepositionOption {
  to: LocationId;
  dist: number;
  fuelNeeded: number;
  travelTicks: number;
  score: number;
}

// Per-call cap on candidates considered. Speculative is O(L² × G) without
// it; with K=6 we evaluate at most K * G * L per call — fine even at scale.
const SPECULATIVE_NEAREST_K = 6;

// When no profitable trade is available from the current location, see if
// an empty positioning trip to another station opens up a trade that's still
// net-positive after the positioning cost.
export function listSpeculativeOptions(
  world: World,
  trader: Trader,
  drawFraction: number = MAX_DRAW_FRACTION,
): SpeculativeOption[] {
  if (maintenanceTravelBlockReason(trader)) return [];

  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  const fuel = trader.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return [];
  const here = trader.location;
  const hereMarket = world.markets[here];
  const fuelGood = fuel?.good ?? ft?.good;
  const localFuelPrice = fuelGood ? hereMarket.prices[fuelGood] ?? 0 : 0;
  const out: SpeculativeOption[] = [];

  // Sort candidate via-points by distance and only consider the K nearest.
  // Long empty trips rarely repay their positioning cost anyway.
  const candidates = reachableNeighbors(world, here)
    .map(n => ({ id: n.to, dist: n.dist }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, SPECULATIVE_NEAREST_K);

  const perDist = fuelPerDistanceFor(trader, ft);
  for (const { id: viaId, dist } of candidates) {
    const emptyFuelNeeded = dist * perDist;
    if (!fuelFree && emptyFuelNeeded > fuel!.qty) continue;

    // Need fuel at via (so we can refuel + continue) OR enough remaining
    // to skip the 2-leg plan. We require the via to have fuel — otherwise
    // the trader would arrive at via and be stuck.
    const viaMarket = world.markets[viaId];
    const viaHasMyFuel = fuelFree || trader.fuelTypes.some(
      f => (viaMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
    );
    if (!viaHasMyFuel) continue;

    const emptyTravelTicks = travelTicksFor(trader, dist);
    const emptyTripMaint = emptyTravelTicks * trader.capacity * MAINTENANCE_PER_CAPACITY;
    const emptyDockingFee = trader.capacity * DOCKING_FEE_PER_CAPACITY;
    const fuelCost = emptyFuelNeeded * localFuelPrice;
    const positioningCost = fuelCost + emptyTripMaint + emptyDockingFee;

    // Best trade originating from via (assuming refueled at via)
    const tradesFromVia = listTradeOptions(world, trader, undefined, drawFraction, viaId);
    const best = tradesFromVia[0];
    if (!best) continue;

    const netProfit = best.totalProfit - positioningCost;
    if (netProfit <= 0) continue;

    const totalTicks = emptyTravelTicks + best.travelTicks + 1;
    out.push({
      via: viaId,
      thenBuy: best.good,
      thenSellAt: best.to,
      qty: best.qty,
      emptyTravelTicks,
      emptyFuelNeeded,
      totalTicks,
      netProfit,
      profitPerTick: netProfit / totalTicks,
    });
  }

  out.sort((a, b) => b.profitPerTick - a.profitPerTick);
  return out;
}

export function isStuck(world: World, trader: Trader): boolean {
  if (ignoresFuel(trader)) return false;
  const ft = activeFuelType(trader);
  if (!ft || !trader.currentFuel || trader.currentFuel.qty <= 0) return true;
  const neighbors = reachableNeighbors(world, trader.location);
  if (neighbors.length === 0) return false;

  const perDist = effectivePerDistance(trader, ft.perDistance);
  let canReachAny = false;
  for (const n of neighbors) {
    const fuelNeeded = n.dist * perDist;
    if (fuelNeeded > trader.currentFuel.qty + 0.001) continue;
    canReachAny = true;

    const dstMarket = world.markets[n.to];
    const fuelAfter = trader.currentFuel.qty - fuelNeeded;
    const dstHasMyFuel = trader.fuelTypes.some(
      f => (dstMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
    );
    const safeReserve = fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
    if (dstHasMyFuel || safeReserve) return false;
  }
  if (!canReachAny) return true;
  return selectRefuelType(world, trader) == null;
}

function cargoExitValue(world: World, trader: Trader, dst: LocationId): number {
  if (trader.cargo.length === 0) return 0;
  let value = 0;
  for (const lot of trader.cargo) {
    const sellNet = marketQuote(world, dst, lot.good) * (1 - SALES_TAX_RATE);
    value += lot.qty * (sellNet - lot.unitPrice);
  }
  return value;
}

function routePressureScore(world: World, dst: LocationId): number {
  const loc = world.locations[dst];
  const market = world.markets[dst];
  let pressure = 0;
  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const target = loc.targetStock[goodId] ?? 0;
    if (target <= 0) continue;
    const stock = market.stock[goodId] ?? 0;
    const ratio = stock / target;
    if (ratio < 0.5) pressure += (0.5 - ratio) * target * 0.02;
    else if (ratio > 1.5) pressure += Math.min(ratio - 1.5, 2) * 0.5;
  }
  return pressure;
}

function listRepositionOptions(world: World, trader: Trader, allowUnsafeHop = false): RepositionOption[] {
  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  const fuel = trader.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return [];

  const hereMarket = world.markets[trader.location];
  const fuelGood = fuel?.good ?? ft?.good;
  const localFuelPrice = fuelGood ? hereMarket.prices[fuelGood] ?? 0 : 0;
  const perDist = fuelPerDistanceFor(trader, ft);
  const cargoLoaded = trader.cargo.length > 0;

  const out: RepositionOption[] = [];
  for (const { to, dist } of reachableNeighbors(world, trader.location)) {
    const fuelNeeded = dist * perDist;
    if (!fuelFree && fuelNeeded > fuel!.qty + 0.001) continue;

    const dstMarket = world.markets[to];
    const fuelAfter = fuelFree ? trader.fuelCapacity : fuel!.qty - fuelNeeded;
    const dstHasMyFuel = fuelFree || trader.fuelTypes.some(
      f => (dstMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
    );
    const safeReserve = fuelFree || fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
    const safeHop = dstHasMyFuel || safeReserve;
    if (!safeHop && !allowUnsafeHop) continue;

    const travelTicks = travelTicksFor(trader, dist);
    const travelCost = fuelNeeded * localFuelPrice
      + travelTicks * trader.capacity * MAINTENANCE_PER_CAPACITY
      + trader.capacity * DOCKING_FEE_PER_CAPACITY;
    const routeDegree = reachableNeighbors(world, to).length;
    const futureTrade = cargoLoaded
      ? 0
      : listTradeOptions(world, trader, undefined, playerDrawFraction(world, trader), to)[0]?.totalProfit ?? 0;
    const cargoValue = cargoLoaded ? cargoExitValue(world, trader, to) : 0;
    const pressure = routePressureScore(world, to);
    const score = futureTrade + cargoValue + pressure + routeDegree * 2 - travelCost - dist * 0.05 - (safeHop ? 0 : 100);
    out.push({ to, dist, fuelNeeded, travelTicks, score });
  }
  return out.sort((a, b) =>
    b.score - a.score
    || a.travelTicks - b.travelTicks
    || a.dist - b.dist
    || a.to.localeCompare(b.to),
  );
}

// Inner helper for multi-hop arrival. Returns true if the next leg
// dispatched cleanly so arriveTrader can skip its idle/dock logic.
function continueRoutePlan(world: World, trader: Trader, nextHop: LocationId, events: TraderEvent[]): boolean {
  if (!world.locations[nextHop]) return false;
  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  if (!fuelFree && !ft) return false;
  const dist = legDistance(world, trader.location, nextHop);
  const fuelNeeded = dist * fuelPerDistanceFor(trader, ft);
  if (!fuelFree && (trader.currentFuel?.qty ?? 0) < fuelNeeded - 0.001) return false;
  departForReposition(world, trader, nextHop, fuelNeeded, travelTicksFor(trader, dist), events);
  return true;
}

function arriveTrader(world: World, trader: Trader, dst: LocationId, events: TraderEvent[]): void {
  trader.location = dst;
  trader.destination = null;
  trader.state = "idle";
  trader.ticksRemaining = 0;
  trader.noOpportunityTicks = 0;
  events.push({ trader: trader.id, kind: "arrive", to: dst });

  // Multi-hop pass-through: if a route plan is queued, dispatch the
  // next leg right away and skip the docking-fee / cargo-autopilot
  // dance for this intermediate stop. The fuel for each leg was
  // already validated up-front by travelTo, but we still re-check at
  // the leg level — if something went sideways (e.g. a tick changed
  // fuel mid-route), we drop the plan and let the idle business
  // logic handle the strand.
  if (trader.routePlan && trader.routePlan.length > 0) {
    const next = trader.routePlan[0];
    if (continueRoutePlan(world, trader, next, events)) {
      trader.routePlan = trader.routePlan.slice(1);
      if (trader.routePlan.length === 0) delete trader.routePlan;
      return;
    }
    delete trader.routePlan;
  }

  chargeDockingFee(world, trader);
  chargeTerritoryToll(world, trader);
  // Real (non-pass-through) docks shift the destination's syndicate
  // control toward the arriving ship's faction. Player ships move the
  // dial harder than NPCs.
  creditActivity(world, trader, trader.location, isPlayerShip(world, trader) ? PLAYER_DOCK_NUDGE : NPC_DOCK_NUDGE);

  // Manual player ships keep cargo loaded until the player chooses Sell.
  if (trader.cargo.length > 0 && trader.pilot !== "manual") {
    if (trader.pilot === "auto" && hasCrew(trader, "captain")) {
      const cargoGoods = new Set(trader.cargo.map(l => l.good));
      for (const job of Object.values(world.jobs)) {
        if (job.acceptedBy != null) continue;
        if (job.kind !== "shortage") continue;
        if (job.destination !== dst) continue;
        if (!job.good) continue;
        if (!cargoGoods.has(job.good)) continue;
        acceptJob(world, job.id, trader.id);
      }
    }

    const movedLots = trader.cargo.map(l => ({ ...l }));
    trader.cargo = [];
    beginUnloadLots(world, trader, movedLots, events);
  }
}

// Crossing toll on docking in foreign syndicate territory. Money flows
// to the foreign syndicate's treasury (closing the loop, not creating a
// sink). No-op for own-territory and independent stations. The player's
// reputation with the foreign syndicate discounts the fee — at full
// reputation passage is free; the player still earns a small rep bump
// per foreign dock so the system has an obvious progression curve.
function chargeTerritoryToll(world: World, trader: Trader): void {
  const { fee: baseFee, toSyndicate } = tollForArrival(world, trader);
  if (baseFee <= 0 || !toSyndicate) return;
  const isPlayer = isPlayerShip(world, trader);
  const fee = effectiveToll(world, toSyndicate, isPlayer);
  if (isPlayer) {
    // Foreign-territory dock — small reputation gain regardless of
    // whether any toll was actually paid (rep=1 ships still earn a
    // little, just much less because the dock's value is fixed).
    bumpPlayerReputation(world, toSyndicate, REP_PER_FOREIGN_DOCK);
  }
  if (fee <= 0) {
    if (isPlayer) {
      const synd = world.syndicates[toSyndicate];
      pushNote(world, trader, `Free passage at ${synd?.name ?? toSyndicate} — reputation maxed`, "info");
    }
    return;
  }
  const taken = Math.min(fee, Math.max(0, trader.funds));
  if (taken <= 0) return;
  trader.funds -= taken;
  const synd = world.syndicates[toSyndicate];
  if (synd) synd.treasury = (synd.treasury ?? 0) + taken;
  if (isPlayer) {
    const rep = world.player?.reputation?.[toSyndicate] ?? 0;
    const repPct = Math.round(rep * 100);
    pushNote(world, trader, `Crossing toll Ç${taken.toFixed(0)} paid to ${synd?.name ?? toSyndicate} (rep ${repPct}%)`, "warn");
  }
}

function departForReposition(world: World, trader: Trader, to: LocationId, fuelNeeded: number, travelTicks: number, events: TraderEvent[]): void {
  const here = trader.location;
  burnTravelFuel(trader, fuelNeeded);
  events.push({ trader: trader.id, kind: "depart", from: here, to });
  if (travelTicks <= 0) {
    arriveTrader(world, trader, to, events);
    return;
  }
  trader.destination = to;
  trader.state = "transit";
  trader.ticksRemaining = travelTicks;
  trader.noOpportunityTicks = 0;
}

function acceptedTradeJobs(world: World, trader: Trader) {
  return Object.values(world.jobs)
    .filter(j => j.kind === "trade" && j.acceptedBy === trader.id)
    .sort((a, b) =>
      a.expiresAt - b.expiresAt
      || b.reward - a.reward
      || a.destination.localeCompare(b.destination),
    );
}

function nextHopToward(world: World, from: LocationId, dst: LocationId): { to: LocationId; dist: number } | null {
  if (from === dst) return null;
  const hasRouteNetwork = Object.values(world.lanes).some(edges => Object.keys(edges).length > 0);
  if (!hasRouteNetwork) {
    const dist = routeDistance(world, from, dst);
    return dist == null ? null : { to: dst, dist };
  }
  const seen = new Set<LocationId>([from]);
  const queue: { id: LocationId; first: LocationId | null }[] = [{ id: from, first: null }];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const neighbors = Object.entries(world.lanes[current.id] ?? {})
      .sort(([a], [b]) => a.localeCompare(b)) as [LocationId, number][];
    for (const [to] of neighbors) {
      if (seen.has(to)) continue;
      const first = current.first ?? to;
      if (to === dst) {
        const dist = world.lanes[from]?.[first];
        return dist == null ? null : { to: first, dist };
      }
      seen.add(to);
      queue.push({ id: to, first });
    }
  }
  return null;
}

function serviceTradeSettlementJob(world: World, trader: Trader, events: TraderEvent[]): boolean {
  const jobs = acceptedTradeJobs(world, trader);
  const job = jobs.find(j => j.destination === trader.location) ?? jobs[0];
  if (!job) return false;

  if (job.destination === trader.location) {
    collectTradeJob(world, job.id, trader.id);
    return true;
  }

  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  const fuel = trader.currentFuel;
  if ((!ft || !fuel) && !fuelFree) {
    events.push({ trader: trader.id, kind: isStuck(world, trader) ? "stuck" : "idle" });
    return true;
  }
  const hop = nextHopToward(world, trader.location, job.destination);
  if (!hop) {
    events.push({ trader: trader.id, kind: "idle" });
    return true;
  }
  const fuelNeeded = hop.dist * fuelPerDistanceFor(trader, ft);
  if (!fuelFree && fuelNeeded > fuel!.qty + 0.001) {
    events.push({ trader: trader.id, kind: isStuck(world, trader) ? "stuck" : "idle" });
    return true;
  }
  const travelTicks = travelTicksFor(trader, hop.dist);
  departForReposition(world, trader, hop.to, fuelNeeded, travelTicks, events);
  return true;
}

function buyPlannedLoadout(world: World, trader: Trader, buys: PlannedBuy[], events: TraderEvent[]): number {
  const here = trader.location;
  const market = world.markets[here];
  let bought = 0;

  for (const buy of buys) {
    const good = world.goods[buy.good];
    if (!good) continue;
    const stock = market.stock[buy.good] ?? 0;
    const price = marketQuote(world, here, buy.good);
    const freeMass = Math.max(0, trader.capacity - totalCargoMass(trader, world));
    const maxByRoom = Math.floor(freeMass / good.weight);
    const maxByStock = Math.floor(stock);
    const maxByFunds = price > 0 ? Math.floor(trader.funds / price) : 0;
    const qty = Math.max(0, Math.min(buy.qty, maxByRoom, maxByStock, maxByFunds));
    if (qty < 1) continue;

    market.stock[buy.good] = stock - qty;
    const purchase = settlePurchase(market, price, qty);
    trader.funds -= purchase.totalCost;
    trader.cargo.push({ good: buy.good, qty, source: here, unitPrice: price, purchasedAt: world.tick });
    events.push({ trader: trader.id, kind: "buy", good: buy.good, qty, unitPrice: price, from: here });
    bought += qty;
  }

  return bought;
}

function executeAutoLoadoutPlan(
  world: World,
  trader: Trader,
  plan: RoutePlanCandidate,
  events: TraderEvent[],
  inflight: Map<string, number>,
): boolean {
  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  const fuel = trader.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return false;
  const dist = routeDistance(world, trader.location, plan.dst);
  if (dist == null) return false;
  const fuelNeeded = dist * fuelPerDistanceFor(trader, ft);
  if (!fuelFree && fuelNeeded > fuel!.qty + 0.001) return false;

  for (const jobId of plan.acceptJobIds) {
    const job = world.jobs[jobId];
    if (job?.acceptedBy == null) acceptJob(world, jobId, trader.id);
  }

  const bought = buyPlannedLoadout(world, trader, plan.buys, events);
  const carryingCargo = trader.cargo.length > 0;
  const hasFuturePickup = (plan.futureBuys?.length ?? 0) > 0;
  if (plan.buys.length > 0 && bought < 1 && !carryingCargo) return false;
  if (plan.buys.length === 0 && !hasFuturePickup && !carryingCargo) return false;

  const travelTicks = travelTicksFor(trader, dist);
  departForReposition(world, trader, plan.dst, fuelNeeded, travelTicks, events);
  for (const lot of trader.cargo) {
    const key = `${plan.dst}|${lot.good}`;
    inflight.set(key, (inflight.get(key) ?? 0) + lot.qty);
  }
  return true;
}

function stepTrader(world: World, trader: Trader, events: TraderEvent[], inflight: Map<string, number>): void {
  if (trader.state === "transit") {
    // If a pending encounter is targeting this ship, freeze its transit step
    // until the player resolves the modal. Defensive — the tick driver also
    // pauses globally while pendingEncounter is set.
    if (world.pendingEncounter && world.pendingEncounter.shipId === trader.id) {
      return;
    }

    // Roll for an encounter. All ships (player + NPC) participate so the
    // sector reads as alive — NPC fights flow into the heatmap and the
    // ledger's "All ships" view. The player-modal pause path is gated on
    // (a) not already having a pending encounter and (b) the ship being
    // the player's; NPC encounters always auto-resolve in-place.
    if (!world.pendingEncounter) {
      const encounter = maybeSpawnEncounter(world, trader);
      if (encounter) {
        const isPlayer = isPlayerShip(world, trader);
        // Dev affordance: when ?dev=1 and the player ship has no mercenary,
        // surface the modal even under autopilot so the encounter is visible
        // without having to swap to manual every time.
        const devPauseOnAuto = DEV_MODE && !trader.crew?.mercenary;
        const shouldPause = isPlayer && (trader.pilot === "manual" || devPauseOnAuto);
        if (shouldPause) {
          // Stamp pending — modal handles the choice; the encounter consumes
          // this transit tick, so don't decrement ticksRemaining.
          world.pendingEncounter = encounter;
          pushShipLog(trader, {
            tick: world.tick,
            kind: "encounter",
            message: `Hostile contact — ${encounter.attacker.name} intercepts route.`,
            tone: "warn",
          });
          return;
        }
        // Auto-resolve (covers player-auto + every NPC). Encounter consumes
        // the tick.
        const choice = encounterAutopilotPolicy(trader, encounter);
        resolveEncounter(world, trader, encounter, choice, true);
        recordEncounter(world, encounter);
        pushShipLog(trader, {
          tick: world.tick,
          kind: "encounter",
          message: encounterLogMessage(world, encounter),
          tone: encounterLogTone(encounter),
        });
        return;
      }
    }

    trader.ticksRemaining -= 1;
    if (trader.ticksRemaining > 0) return;

    const dst = trader.destination!;
    arriveTrader(world, trader, dst, events);
    return;
  }

  // Drip-unload from a prior arrival or manual Sell click. Each lot tracks its
  // own ticks remaining, so a fresh Sell click never resets the drain rate of
  // already-unloading lots — the new lots get their own UNLOAD_TICKS window.
  if (isUnloading(trader)) {
    const buf = trader.unloadingCargo!;
    for (const lot of buf) {
      const ticksLeft = lot.unloadTicksRemaining ?? UNLOAD_TICKS;
      if (ticksLeft <= 0) continue;
      const dripQty = ticksLeft <= 1 ? lot.qty : lot.qty / ticksLeft;
      if (dripQty <= 0) {
        lot.unloadTicksRemaining = ticksLeft - 1;
        continue;
      }
      settleUnloadedCargo(world, trader, lot, dripQty, events);
      lot.qty -= dripQty;
      lot.unloadTicksRemaining = ticksLeft - 1;
      // Lot finished draining — emit one summary "sold N at avg Ç" event
      // for the entire unload using the snapshot we took at begin time.
      const lotDone = lot.qty <= 0.001 || (lot.unloadTicksRemaining ?? 0) <= 0;
      if (lotDone && lot.unloadOriginalQty != null) {
        const totalQty = lot.unloadOriginalQty;
        const totalProceeds = lot.unloadProceedsSum ?? 0;
        const avgUnit = totalQty > 0 ? totalProceeds / totalQty : 0;
        events.push({ trader: trader.id, kind: "sell", good: lot.good, qty: totalQty, unitPrice: avgUnit, to: trader.location });
      }
    }
    trader.unloadingCargo = buf.filter(l => l.qty > 0.001 && (l.unloadTicksRemaining ?? 0) > 0);
    if (trader.unloadingCargo.length === 0) trader.unloadingCargo = undefined;
    return;
  }

  if (trader.pilot === "manual") {
    trader.noOpportunityTicks = 0;
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  // Player ships in auto mode require a pilot on the crew. Without one
  // they sit idle just like manual ships — the player must hire to unlock
  // autonomous trading. NPCs (pilot === "npc") never have crew; their auto
  // behavior is implicit.
  if (trader.pilot === "auto" && !hasCrew(trader, "captain")) {
    trader.noOpportunityTicks = 0;
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  if (maintenanceTravelBlockReason(trader)) {
    trader.noOpportunityTicks = 0;
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  if (acceptedTradeJobs(world, trader).some(j => j.destination === trader.location)) {
    trader.noOpportunityTicks = 0;
    serviceTradeSettlementJob(world, trader, events);
    return;
  }

  tryRefuel(world, trader, events);
  restoreNpcOperatingFloat(world, trader);

  if (acceptedTradeJobs(world, trader).length > 0) {
    trader.noOpportunityTicks = 0;
    serviceTradeSettlementJob(world, trader, events);
    return;
  }

  const loadoutPlan = bestAutoLoadoutPlan(world, trader);
  const choice = evaluateOptions(world, trader, inflight);
  if (loadoutPlan && (!choice || loadoutPlan.value >= choice.totalProfit)) {
    if (executeAutoLoadoutPlan(world, trader, loadoutPlan, events, inflight)) return;
  }

  if (!choice) {
    // No direct trade — try speculative travel: empty trip to a station
    // where a profitable trade exists, even after positioning costs.
    if (trader.cargo.length === 0) {
      const speculative = listSpeculativeOptions(world, trader, playerDrawFraction(world, trader));
      const sp = speculative[0];
      if (sp) {
        // Depart empty for the via point. On arrival, refuel + take the
        // best trade from there (which we'll re-evaluate next tick).
        departForReposition(world, trader, sp.via, sp.emptyFuelNeeded, sp.emptyTravelTicks, events);
        return;
      }
    }

    trader.noOpportunityTicks = (trader.noOpportunityTicks ?? 0) + 1;
    if (trader.noOpportunityTicks >= MAX_NO_OPPORTUNITY_TICKS) {
      const emergencyHop = selectRefuelType(world, trader) == null;
      const reposition = listRepositionOptions(world, trader, emergencyHop)[0];
      if (reposition) {
        departForReposition(world, trader, reposition.to, reposition.fuelNeeded, reposition.travelTicks, events);
        return;
      }
    }
    events.push({ trader: trader.id, kind: isStuck(world, trader) ? "stuck" : "idle" });
    return;
  }

  trader.noOpportunityTicks = 0;
  const here = trader.location;
  const srcMarket = world.markets[here];

  // Auto-pilot multi-good loadout: before the primary buy, pre-load goods
  // for any accepted contract bound for the same destination. Solves the
  // case where the engine picks a high-margin generic trade and would
  // otherwise abandon a parallel accepted contract that could have ridden
  // along in the same trip. Contract goods load FIRST (high-tier first),
  // primary fills the remaining bay.
  const canPreloadContracts = isPlayerShip(world, trader)
    && trader.pilot === "auto"
    && hasCrew(trader, "captain");
  const tierRank = { high: 0, medium: 1, low: 2 } as const;
  const contractLoads: { good: GoodId; qty: number; price: number }[] = [];
  let preloadMass = 0;
  let fundsLeft = trader.funds;
  if (canPreloadContracts) {
    const accs = Object.values(world.jobs)
      .filter(j => j.kind !== "trade" && j.good != null && j.acceptedBy === trader.id && j.destination === choice.to && j.good !== choice.good)
      .sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);
    for (const c of accs) {
      if (!c.good) continue;
      const remaining = c.qty - c.delivered;
      if (remaining <= 0) continue;
      const g = world.goods[c.good];
      if (!g) continue;
      const stock = srcMarket.stock[c.good] ?? 0;
      const price = marketQuote(world, here, c.good);
      const roomMass = trader.capacity - preloadMass;
      const maxByRoom = Math.floor(roomMass / g.weight);
      const maxByFunds = price > 0 ? Math.floor(fundsLeft / price) : 0;
      const buyQty = Math.max(0, Math.min(remaining, Math.floor(stock), maxByRoom, maxByFunds));
      if (buyQty < 1) continue;
      contractLoads.push({ good: c.good, qty: buyQty, price });
      preloadMass += buyQty * g.weight;
      fundsLeft -= buyQty * price;
    }
  }

  // Recompute primary qty against the bay + funds remaining after preloads.
  const primaryWeight = world.goods[choice.good].weight;
  const primaryMaxByRoom = Math.floor((trader.capacity - preloadMass) / primaryWeight);
  const primaryMaxByFunds = choice.buyPrice > 0 ? Math.floor(fundsLeft / choice.buyPrice) : 0;
  const primaryQty = Math.max(0, Math.min(choice.qty, primaryMaxByRoom, primaryMaxByFunds));

  // If preloads ate every byte of cargo and primary can't ship, still depart
  // with just the contracts (commitments win). If neither, abort to idle.
  if (primaryQty < 1 && contractLoads.length === 0) {
    trader.noOpportunityTicks = (trader.noOpportunityTicks ?? 0) + 1;
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  trader.cargo = [];
  for (const l of contractLoads) {
    srcMarket.stock[l.good] = (srcMarket.stock[l.good] ?? 0) - l.qty;
    const purchase = settlePurchase(srcMarket, l.price, l.qty);
    trader.funds -= purchase.totalCost;
    trader.cargo.push({ good: l.good, qty: l.qty, source: here, unitPrice: l.price, purchasedAt: world.tick });
    events.push({ trader: trader.id, kind: "buy", good: l.good, qty: l.qty, unitPrice: l.price, from: here });
  }
  if (primaryQty > 0) {
    srcMarket.stock[choice.good] = (srcMarket.stock[choice.good] ?? 0) - primaryQty;
    const purchase = settlePurchase(srcMarket, choice.buyPrice, primaryQty);
    trader.funds -= purchase.totalCost;
    trader.cargo.push({ good: choice.good, qty: primaryQty, source: here, unitPrice: choice.buyPrice, purchasedAt: world.tick });
    events.push({ trader: trader.id, kind: "buy", good: choice.good, qty: primaryQty, unitPrice: choice.buyPrice, from: here });
  }

  departForReposition(world, trader, choice.to, choice.fuelNeeded, choice.travelTicks, events);

  for (const lot of trader.cargo) {
    const key = `${choice.to}|${lot.good}`;
    inflight.set(key, (inflight.get(key) ?? 0) + lot.qty);
  }
}

export type ExecuteResult =
  | { ok: true; events: TraderEvent[]; jobCompletions?: JobCompletionEvent[] }
  | { ok: false; reason: string };

export function executeTrade(world: World, trader: Trader, choice: TradeOption): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };
  if (isUnloading(trader)) return { ok: false, reason: "Wait for the current unload to finish before departing." };
  const blocked = maintenanceTravelBlockReason(trader);
  if (blocked) return { ok: false, reason: blocked };

  const here = trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  if ((!fuel || !ft) && !fuelFree) return { ok: false, reason: "No compatible fuel in tank." };
  const dist = routeDistance(world, here, choice.to);
  if (dist == null) return { ok: false, reason: "No plotted route to destination." };
  const fuelNeeded = dist * fuelPerDistanceFor(trader, ft);
  if (!fuelFree && fuel!.qty < fuelNeeded - 0.001) return { ok: false, reason: "Not enough fuel for this trip." };
  if (trader.funds < choice.qty * choice.buyPrice) return { ok: false, reason: "Not enough funds to buy this cargo." };

  const stockHere = srcMarket.stock[choice.good] ?? 0;
  if (stockHere < choice.qty) return { ok: false, reason: `Source has only ${stockHere.toFixed(0)} of ${choice.good}.` };

  const goodWeight = world.goods[choice.good].weight;
  const currentMass = totalCargoMass(trader, world);
  const addMass = choice.qty * goodWeight;
  if (currentMass + addMass > trader.capacity + 0.001) {
    return { ok: false, reason: "Not enough cargo space." };
  }

  const events: TraderEvent[] = [];

  srcMarket.stock[choice.good] = stockHere - choice.qty;
  const purchase = settlePurchase(srcMarket, choice.buyPrice, choice.qty);
  trader.funds -= purchase.totalCost;
  addCargoLot(trader, choice.good, choice.qty, here, choice.buyPrice, world.tick);
  events.push({
    trader: trader.id,
    kind: "buy",
    good: choice.good,
    qty: choice.qty,
    unitPrice: choice.buyPrice,
    from: here,
  });
  // NPC trade-and-go also nudges the source-station's control toward
  // this trader's syndicate. Same hook the manual buy uses; this is the
  // NPC autopilot path so it always pays NPC rates.
  creditActivity(world, trader, here, purchase.totalCost * NPC_TRADE_PER_CREDIT);

  departForReposition(world, trader, choice.to, fuelNeeded, travelTicksFor(trader, dist), events);

  for (const ev of events) pushTraderEvent(world, trader, ev);
  return { ok: true, events };
}

function addCargoLot(
  trader: Trader,
  goodId: GoodId,
  qty: number,
  source: string,
  unitPrice: number,
  tick: number,
): void {
  // Always push a new lot — never merge. Each purchase keeps its own
  // source/price/age so the player can attribute later sales to specific
  // origins, hedge across lots, and see real cost-basis distribution.
  trader.cargo.push({ good: goodId, qty, source, unitPrice, purchasedAt: tick });
}

export type UpgradeInstallResult =
  | { ok: true; installed: GoodId; replaced?: GoodId }
  | { ok: false; reason: string };

export type UpgradeRemoveResult =
  | { ok: true; removed: GoodId }
  | { ok: false; reason: string };

interface UpgradeInstallSnapshot {
  cargo: CargoLot[];
  upgrades?: ShipUpgradeSlots;
  capacity: number;
  speed: number;
  fuelCapacity: number;
  baseCapacity?: number;
  baseSpeed?: number;
  baseFuelCapacity?: number;
  baseHull?: number;
  baseWeaponPower?: number;
  hull?: number;
  weaponPower?: number;
  currentFuel: Trader["currentFuel"];
  funds: number;
}

function snapshotUpgradeInstall(trader: Trader): UpgradeInstallSnapshot {
  return {
    cargo: trader.cargo.map(l => ({ ...l })),
    upgrades: trader.upgrades ? { ...trader.upgrades } : undefined,
    capacity: trader.capacity,
    speed: trader.speed,
    fuelCapacity: trader.fuelCapacity,
    baseCapacity: trader.baseCapacity,
    baseSpeed: trader.baseSpeed,
    baseFuelCapacity: trader.baseFuelCapacity,
    baseHull: trader.baseHull,
    baseWeaponPower: trader.baseWeaponPower,
    hull: trader.hull,
    weaponPower: trader.weaponPower,
    currentFuel: trader.currentFuel ? { ...trader.currentFuel } : null,
    funds: trader.funds,
  };
}

function restoreUpgradeInstall(trader: Trader, snap: UpgradeInstallSnapshot): void {
  trader.cargo = snap.cargo.map(l => ({ ...l }));
  trader.upgrades = snap.upgrades ? { ...snap.upgrades } : undefined;
  trader.capacity = snap.capacity;
  trader.speed = snap.speed;
  trader.fuelCapacity = snap.fuelCapacity;
  trader.baseCapacity = snap.baseCapacity;
  trader.baseSpeed = snap.baseSpeed;
  trader.baseFuelCapacity = snap.baseFuelCapacity;
  trader.baseHull = snap.baseHull;
  trader.baseWeaponPower = snap.baseWeaponPower;
  trader.hull = snap.hull;
  trader.weaponPower = snap.weaponPower;
  trader.currentFuel = snap.currentFuel ? { ...snap.currentFuel } : null;
  trader.funds = snap.funds;
}

function cargoQty(trader: Trader, goodId: GoodId): number {
  return trader.cargo
    .filter(l => l.good === goodId)
    .reduce((s, l) => s + l.qty, 0);
}

function removeCargoUnit(trader: Trader, goodId: GoodId): boolean {
  if (cargoQty(trader, goodId) < 1 - 0.001) return false;
  const matching = trader.cargo
    .map((lot, idx) => ({ lot, idx }))
    .filter(x => x.lot.good === goodId)
    .sort((a, b) => a.lot.purchasedAt - b.lot.purchasedAt);

  let remaining = 1;
  const toRemove: number[] = [];
  for (const { lot, idx } of matching) {
    if (remaining <= 0.001) break;
    const take = Math.min(lot.qty, remaining);
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= 0.001) toRemove.push(idx);
  }
  toRemove.sort((a, b) => b - a).forEach(i => trader.cargo.splice(i, 1));
  return remaining <= 0.001;
}

function currentCargoMass(trader: Trader, world: World): number {
  return totalCargoMass(trader, world);
}

function replacedUpgradeCargoPrice(world: World, trader: Trader, goodId: GoodId): number {
  return marketQuote(world, trader.location, goodId);
}

function finalizeUpgradeInstall(
  world: World,
  trader: Trader,
  goodId: GoodId,
  previous: GoodId | undefined,
): UpgradeInstallResult {
  recomputeShipStats(trader);
  const mass = currentCargoMass(trader, world);
  if (mass > trader.capacity + 0.001) {
    return {
      ok: false,
      reason: `Installing that module would leave ${mass.toFixed(0)} mass in a ${trader.capacity.toFixed(0)} cargo hold.`,
    };
  }

  const def = upgradeDef(goodId)!;
  pushNote(
    world,
    trader,
    previous
      ? `Installed ${def.name}; old module moved to cargo`
      : `Installed ${def.name}`,
    "good",
  );
  return { ok: true, installed: goodId, replaced: previous };
}

export function installUpgradeFromCargo(world: World, trader: Trader, goodId: GoodId): UpgradeInstallResult {
  if (trader.state !== "idle") return { ok: false, reason: "Can only install upgrades while docked." };
  const def = upgradeDef(goodId);
  if (!def) return { ok: false, reason: "That cargo is not a ship upgrade." };
  // Weapon-class upgrades route to the first empty weapon mount on a
  // multi-mount ship; otherwise fall back to the catalog slot. Duplicate
  // weapons are allowed (you might want two of the same gun).
  const targetSlot = def.slot === "weapon" ? firstEmptyWeaponSlot(trader) : def.slot;
  if (def.slot !== "weapon" && trader.upgrades?.[targetSlot] === goodId) return { ok: false, reason: `${def.name} is already installed.` };
  if (cargoQty(trader, goodId) < 1 - 0.001) return { ok: false, reason: `No ${def.name} in cargo.` };

  const snap = snapshotUpgradeInstall(trader);
  const previous = trader.upgrades?.[targetSlot];

  removeCargoUnit(trader, goodId);
  trader.upgrades = { ...(trader.upgrades ?? {}), [targetSlot]: goodId };
  if (previous) {
    addCargoLot(trader, previous, 1, trader.location, replacedUpgradeCargoPrice(world, trader, previous), world.tick);
  }

  const result = finalizeUpgradeInstall(world, trader, goodId, previous);
  if (!result.ok) restoreUpgradeInstall(trader, snap);
  if (result.ok && isPlayerShip(world, trader)) incrementManualActions(world);
  return result;
}

export function removeInstalledUpgrade(world: World, trader: Trader, slot: UpgradeSlot): UpgradeRemoveResult {
  if (trader.state !== "idle") return { ok: false, reason: "Can only remove upgrades while docked." };
  const goodId = trader.upgrades?.[slot];
  if (!goodId) return { ok: false, reason: "No module installed in that slot." };
  const def = upgradeDef(goodId);
  if (!def) return { ok: false, reason: "Installed module definition is missing." };

  const snap = snapshotUpgradeInstall(trader);
  const nextUpgrades = { ...(trader.upgrades ?? {}) };
  delete nextUpgrades[slot];
  trader.upgrades = Object.keys(nextUpgrades).length > 0 ? nextUpgrades : undefined;
  addCargoLot(trader, goodId, 1, trader.location, replacedUpgradeCargoPrice(world, trader, goodId), world.tick);
  recomputeShipStats(trader);

  const mass = currentCargoMass(trader, world);
  if (mass > trader.capacity + 0.001) {
    restoreUpgradeInstall(trader, snap);
    return {
      ok: false,
      reason: `Removing ${def.name} would leave ${mass.toFixed(0)} mass in a ${trader.capacity.toFixed(0)} cargo hold.`,
    };
  }

  pushNote(world, trader, `Removed ${def.name}; module moved to cargo`, "good");
  return { ok: true, removed: goodId };
}

export function installUpgradeFromMarket(world: World, trader: Trader, goodId: GoodId): UpgradeInstallResult {
  if (trader.state !== "idle") return { ok: false, reason: "Can only install upgrades while docked." };
  const def = upgradeDef(goodId);
  if (!def) return { ok: false, reason: "That good is not a ship upgrade." };
  // Weapons route to the first open mount on multi-mount ships; the
  // duplicate-already-installed rule applies only to non-weapon slots.
  const targetSlot = def.slot === "weapon" ? firstEmptyWeaponSlot(trader) : def.slot;
  if (def.slot !== "weapon" && trader.upgrades?.[targetSlot] === goodId) return { ok: false, reason: `${def.name} is already installed.` };

  // Belt-and-suspenders milestone gate. Stocking is also gated at the
  // market level (market.stock stays at 0), but if stock is somehow non-zero
  // for a locked tier we still refuse the buy here so the rule holds end-to-end.
  const tierKey = upgradeTierMilestone(def.tier);
  if (tierKey && !isMilestoneMet(world, tierKey)) {
    const remaining = MILESTONES[tierKey] - (world.player?.manualActionCount ?? 0);
    return { ok: false, reason: `Tier-${def.tier} modules unlock at ${MILESTONES[tierKey]} actions (${remaining} more to go) — ${MILESTONE_LABELS[tierKey].label}.` };
  }

  const market = world.markets[trader.location];
  const stock = market.stock[goodId] ?? 0;
  if (stock < 1) return { ok: false, reason: `${def.name} is not in stock here.` };
  const price = marketQuote(world, trader.location, goodId);
  if (trader.funds < price - 0.001) {
    return { ok: false, reason: `Need Ç${price.toFixed(0)}, have Ç${trader.funds.toFixed(0)}.` };
  }

  const snap = snapshotUpgradeInstall(trader);
  const previous = trader.upgrades?.[targetSlot];
  const stockBefore = stock;
  const treasuryBefore = market.treasury;

  market.stock[goodId] = stock - 1;
  const purchase = settlePurchase(market, price, 1);
  trader.funds -= purchase.totalCost;
  trader.upgrades = { ...(trader.upgrades ?? {}), [targetSlot]: goodId };
  if (previous) {
    addCargoLot(trader, previous, 1, trader.location, replacedUpgradeCargoPrice(world, trader, previous), world.tick);
  }

  const result = finalizeUpgradeInstall(world, trader, goodId, previous);
  if (!result.ok) {
    restoreUpgradeInstall(trader, snap);
    market.stock[goodId] = stockBefore;
    market.treasury = treasuryBefore;
  }
  if (result.ok && isPlayerShip(world, trader)) incrementManualActions(world);
  return result;
}

export function buyAtLocation(world: World, trader: Trader, goodId: GoodId, qty: number): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };
  if (qty <= 0) return { ok: false, reason: "Quantity must be positive." };

  const good = world.goods[goodId];
  if (!good) return { ok: false, reason: `Unknown good: ${goodId}` };

  const market = world.markets[trader.location];
  const stock = market.stock[goodId] ?? 0;
  if (stock < qty) return { ok: false, reason: `Only ${stock.toFixed(0)} ${goodId} in stock here.` };

  // Sum of all existing lots' mass — multi-lot cargo means many goods may share the bay.
  // unloadingCargo also counts: still aboard until the drip moves it off.
  const currentMass = totalCargoMass(trader, world);
  const addMass = qty * good.weight;
  if (currentMass + addMass > trader.capacity + 0.001) {
    const room = Math.max(0, (trader.capacity - currentMass) / good.weight);
    return { ok: false, reason: `Not enough cargo space. Max additional: ${Math.floor(room)} ${goodId}.` };
  }

  const basePrice = marketQuote(world, trader.location, goodId);
  // Apply the trader's buyDiscount upgrade plus the own-territory
  // bonus when applicable — the market deposits the discounted amount
  // so the float stays conserved (treasury simply earns less on this
  // purchase). Combined cap of 0.5 mirrors the upgrade-only path.
  const totalBuyDiscount = Math.min(0.5, buyDiscountFraction(trader) + territoryBuyBonus(world, trader));
  const price = basePrice * (1 - totalBuyDiscount);
  const cost = qty * price;
  if (trader.funds < cost - 0.001) return { ok: false, reason: `Need Ç${cost.toFixed(0)}, have Ç${trader.funds.toFixed(0)}.` };

  market.stock[goodId] = stock - qty;
  const purchase = settlePurchase(market, price, qty);
  trader.funds -= purchase.totalCost;
  addCargoLot(trader, goodId, qty, trader.location, price, world.tick);

  const events: TraderEvent[] = [{ trader: trader.id, kind: "buy", good: goodId, qty, unitPrice: price, from: trader.location }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
  // Buying credits the source station with this trader's syndicate too —
  // commerce of any kind extends the syndicate's reach. Player buys at
  // a foreign station also accrue reputation with that station's owner.
  {
    const isPlayer = isPlayerShip(world, trader);
    const buyRate = isPlayer ? PLAYER_TRADE_PER_CREDIT : NPC_TRADE_PER_CREDIT;
    creditActivity(world, trader, trader.location, purchase.totalCost * buyRate);
    if (isPlayer) {
      const stationFaction = world.locations[trader.location]?.traits.faction;
      if (stationFaction && stationFaction !== trader.syndicateId) {
        bumpPlayerReputation(world, stationFaction, purchase.totalCost * REP_PER_FOREIGN_CREDIT);
      }
    }
  }
  if (isPlayerShip(world, trader)) incrementManualActions(world);
  return { ok: true, events };
}

export function sellAtLocation(world: World, trader: Trader, goodId: GoodId, qty?: number): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };

  // Match all lots of this good (could be many — purchases are per-lot now).
  // Sort oldest-first (FIFO) so per-lot cost basis attribution is conventional.
  const matching = trader.cargo
    .map((lot, idx) => ({ lot, idx }))
    .filter(x => x.lot.good === goodId)
    .sort((a, b) => a.lot.purchasedAt - b.lot.purchasedAt);

  if (matching.length === 0) return { ok: false, reason: `No ${goodId} in cargo.` };

  const totalAvailable = matching.reduce((s, x) => s + x.lot.qty, 0);
  const sellQty = qty ?? totalAvailable;
  if (sellQty <= 0) return { ok: false, reason: "Quantity must be positive." };
  if (sellQty > totalAvailable + 0.001) {
    return { ok: false, reason: `Only have ${totalAvailable} units of ${goodId}.` };
  }

  // Move sellQty FIFO from cargo into the unloading flow. Each new lot gets
  // its own countdown unless the ship has an instant-unload module, in which
  // case it settles before this action returns.
  const movedLots: CargoLot[] = [];
  let remaining = sellQty;
  const toRemove: number[] = [];
  for (const { lot, idx } of matching) {
    if (remaining <= 0.001) break;
    const take = Math.min(lot.qty, remaining);
    if (take >= lot.qty - 0.001) {
      movedLots.push({ ...lot, unloadTicksRemaining: undefined });
      toRemove.push(idx);
    } else {
      lot.qty -= take;
      movedLots.push({ ...lot, qty: take, unloadTicksRemaining: undefined });
    }
    remaining -= take;
  }
  toRemove.sort((a, b) => b - a).forEach(i => trader.cargo.splice(i, 1));

  const events: TraderEvent[] = [];
  beginUnloadLots(world, trader, movedLots, events);
  for (const ev of events) pushTraderEvent(world, trader, ev);
  if (isPlayerShip(world, trader)) incrementManualActions(world);
  return { ok: true, events };
}

export function refuelManual(world: World, trader: Trader, qty?: number): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };

  const ft = selectRefuelType(world, trader);
  if (!ft) return { ok: false, reason: "No compatible fuel for sale here." };

  const market = world.markets[trader.location];
  const stock = market.stock[ft.good] ?? 0;
  const price = market.prices[ft.good];

  const switching = !trader.currentFuel || trader.currentFuel.good !== ft.good;
  const currentQty = switching ? 0 : trader.currentFuel!.qty;
  const room = trader.fuelCapacity - currentQty;
  const desired = qty ?? room;
  const buyQty = Math.min(desired, room, stock, price > 0 ? trader.funds / price : 0);

  if (buyQty <= 0.001) {
    if (room <= 0) return { ok: false, reason: "Tank already full." };
    if (stock <= 0) return { ok: false, reason: `No ${ft.good} for sale here.` };
    return { ok: false, reason: "Not enough funds to refuel." };
  }

  market.stock[ft.good] = stock - buyQty;
  const purchase = settlePurchase(market, price, buyQty);
  trader.funds -= purchase.totalCost;
  trader.currentFuel = { good: ft.good, qty: currentQty + buyQty };

  const events: TraderEvent[] = [{ trader: trader.id, kind: "refuel", good: ft.good, qty: buyQty, unitPrice: price }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
  if (isPlayerShip(world, trader)) incrementManualActions(world);
  return { ok: true, events };
}

export function travelTo(world: World, trader: Trader, dst: LocationId): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is already in transit." };
  if (dst === trader.location) return { ok: false, reason: "Already at destination." };
  if (!world.locations[dst]) return { ok: false, reason: "Unknown destination." };

  if (isUnloading(trader)) return { ok: false, reason: "Wait for the current unload to finish before departing." };
  const blocked = maintenanceTravelBlockReason(trader);
  if (blocked) return { ok: false, reason: blocked };

  const fuelFree = ignoresFuel(trader);
  const ft = activeFuelType(trader) ?? trader.fuelTypes[0] ?? null;
  const fuel = trader.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return { ok: false, reason: "No compatible fuel in tank." };

  // Plot the shortest path through the lane network. Adjacent
  // destinations resolve to a 2-node path (origin → dst); remote
  // destinations get a multi-hop path that we queue on
  // trader.routePlan and auto-dispatch on each arrival.
  const path = findRoutePath(world, trader.location, dst);
  if (!path || path.length < 2) {
    return { ok: false, reason: "No plotted route to destination." };
  }
  const totalDist = pathDistance(world, path);
  const totalFuel = totalDist * fuelPerDistanceFor(trader, ft);
  if (!fuelFree && fuel!.qty < totalFuel - 0.001) {
    return { ok: false, reason: `Need ${totalFuel.toFixed(1)} fuel for the full route, have ${fuel!.qty.toFixed(1)}.` };
  }

  // First-leg figures used by departForReposition. Fuel for the leg
  // is debited up-front; the remaining hops run their own
  // departForReposition cycles when the trader arrives at each stop.
  const nextHop = path[1];
  const firstDist = legDistance(world, trader.location, nextHop);
  const firstFuel = firstDist * fuelPerDistanceFor(trader, ft);
  const firstTicks = travelTicksFor(trader, firstDist);

  if (path.length > 2) {
    trader.routePlan = path.slice(2);
  } else if (trader.routePlan) {
    delete trader.routePlan;
  }

  const events: TraderEvent[] = [];
  departForReposition(world, trader, nextHop, firstFuel, firstTicks, events);
  for (const ev of events) pushTraderEvent(world, trader, ev);
  if (isPlayerShip(world, trader)) incrementManualActions(world);
  return { ok: true, events };
}

// Per-hull-point repair cost for combat damage. Repair fees flow to the
// station's local treasury (closed loop, like other settlement rails).
export const HULL_REPAIR_PER_POINT = 200;

export function hullRepairCost(trader: Trader): number {
  const base = trader.baseHull ?? trader.hull ?? 0;
  const cur = trader.hull ?? base;
  const damage = Math.max(0, base - cur);
  return Math.round(damage * HULL_REPAIR_PER_POINT);
}

// Pay off both maintenance debt and combat hull damage in one settlement.
// Maintenance debt only accrues for player ships missing a mechanic; combat
// damage hits any player ship that took losses or fled-damaged. Charged to
// the ship's own wallet; hull-damage portion is deposited into the docking
// station's treasury.
export function repairShip(world: World, trader: Trader): { ok: true; paid: number } | { ok: false; reason: string } {
  if (trader.state !== "idle") return { ok: false, reason: "Can only repair while docked." };
  const debt = trader.maintenanceDebt ?? 0;
  const hullCost = hullRepairCost(trader);
  const total = debt + hullCost;
  if (total <= 0) return { ok: false, reason: "Ship is in good repair — nothing to fix." };
  if (trader.funds < total) {
    return { ok: false, reason: `Need Ç${Math.round(total).toLocaleString()} to repair, ship has Ç${Math.round(trader.funds).toLocaleString()}.` };
  }
  trader.funds -= total;
  if (debt > 0) trader.maintenanceDebt = 0;
  if (hullCost > 0) {
    trader.hull = trader.baseHull ?? trader.hull;
    // Hull-repair portion deposits into the docking station's treasury.
    const market = world.markets[trader.location];
    if (market) market.treasury += hullCost;
  }
  pushNote(world, trader, `Repaired ship — Ç${Math.round(total).toLocaleString()} paid`, "good");
  return { ok: true, paid: total };
}

export function stepTraders(world: World): TraderEvent[] {
  const events: TraderEvent[] = [];
  const inflight = inTransitArrivalsByDestGood(world);
  const playerIds = new Set(world.player?.shipIds ?? []);
  const orderedTraders = Object.values(world.traders).sort((a, b) =>
    Number(playerIds.has(b.id)) - Number(playerIds.has(a.id))
  );
  for (const trader of orderedTraders) {
    stepTrader(world, trader, events, inflight);
  }
  // Update stranded counters once per tick. Drives rescue-job tier escalation:
  // the longer a trader has been stuck, the more urgent (and lucrative) the
  // rescue contract becomes.
  for (const trader of Object.values(world.traders)) {
    if (trader.state !== "idle") { trader.stuckTicks = 0; continue; }
    trader.stuckTicks = isStuck(world, trader) ? (trader.stuckTicks ?? 0) + 1 : 0;
  }
  // Funnel each event into the originating ship's log so NPC + auto-pilot
  // history is captured with the same shape as manual-action events.
  for (const ev of events) {
    const ship = world.traders[ev.trader];
    if (ship) pushTraderEvent(world, ship, ev);
  }
  return events;
}
