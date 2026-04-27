import type { CargoLot, FuelType, GoodId, JobId, LocationId, ShipUpgradeSlots, Trader, TraderEvent, World } from "./types";
import { reachableNeighbors, routeDistance } from "./geometry";
import { priceFor } from "./pricing";
import { chargeDockingFee, DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";
import { acceptJob, creditJobOnDelivery, type JobCompletionEvent } from "./jobs";
import { pushNote, pushTraderEvent } from "./log";
import { effectivePerDistance, hasCrew, MAINTENANCE_DEBT_TRAVEL_BLOCK, recomputeShipStats } from "./crew";
import { upgradeDef } from "./upgrades";

export const MIN_PROFIT_PER_TICK = 0.05;
export const MAX_DRAW_FRACTION = 0.5;
export const REFUEL_THRESHOLD = 0.6;          // refuel earlier — was 0.4
export const STRANDING_RESERVE = 0.3;         // require 30% reserve at arrival — was 0.2
export const INFLIGHT_WEIGHT = 1.0;
export const MAX_NO_OPPORTUNITY_TICKS = 12;
export const NPC_OPERATING_FLOAT = 5_000;

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
  const emergencyCredit = !isPlayerShip(world, trader)
    && (isStuck(world, trader) || (trader.noOpportunityTicks ?? 0) >= MAX_NO_OPPORTUNITY_TICKS);
  const affordable = emergencyCredit ? Infinity : price > 0 ? trader.funds / price : 0;
  const buyQty = Math.min(need, stock, affordable);
  if (buyQty <= 0.001) return;

  market.stock[choice.good] = stock - buyQty;
  trader.funds = Math.max(0, trader.funds - buyQty * price);
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
    && (trader.pilot === "manual" || (trader.pilot === "auto" && hasCrew(trader, "navigator")));
}

function playerDrawFraction(world: World, trader: Trader): number | undefined {
  return isPlayerShip(world, trader) ? 1.0 : undefined;
}

function restoreNpcOperatingFloat(world: World, trader: Trader): void {
  if (isPlayerShip(world, trader)) return;
  if (trader.cargo.length > 0) return;
  if ((trader.noOpportunityTicks ?? 0) < MAX_NO_OPPORTUNITY_TICKS) return;
  if (trader.funds >= NPC_OPERATING_FLOAT) return;
  trader.funds = NPC_OPERATING_FLOAT;
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
  const ft = activeFuelType(trader);
  if (!fuel || !ft) return [];
  const localFuelPrice = srcMarket.prices[fuel.good];
  // When evaluating from a hypothetical location (speculative travel),
  // assume the ship refueled at that location (fuel = capacity).
  const isHypothetical = fromLocation != null && fromLocation !== trader.location;
  const effectiveFuel = isHypothetical ? trader.fuelCapacity : fuel.qty;
  const options: TradeOption[] = [];

  // Pre-index this trader's accepted contracts by (destination|good) → bonus
  // info. Routes that match an accepted job get the per-unit reward credited
  // on top of the trade profit, so the auto-pilot prefers them when picking
  // the next move (and follows through on contracts it has signed up for).
  //
  // For player ships in manual mode (where the engine runs as a hint) and
  // auto+navigator (where the navigator auto-accepts on arrival), also fold
  // in unaccepted shortage contracts at the destination. This makes the
  // engine actively chase contract-aligned trades instead of stumbling onto
  // them — and turns the navigator into a real value-add.
  const willRealizeUnaccepted = canUseContractCargoPlanning(world, trader);
  const jobBonusMap = new Map<string, RouteJobBonus[]>();
  for (const j of Object.values(world.jobs)) {
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
  const usedMass = trader.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
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
    const good = world.goods[goodId];
    const buyPrice = srcMarket.prices[goodId];
    const srcStock = srcMarket.stock[goodId] ?? 0;

    const perDist = effectivePerDistance(trader, ft.perDistance);
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
      const fuelAfter = effectiveFuel - fuelNeeded;
      const deliversCompatibleFuel = trader.fuelTypes.some(f => f.good === goodId);
      const dstHasMyFuel = trader.fuelTypes.some(
        f => ((dstMarket.stock[f.good] ?? 0) + (f.good === goodId ? maxQty : 0)) >= trader.fuelCapacity * REFUEL_THRESHOLD,
      );
      const safeReserve = fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
      if (!dstHasMyFuel && !safeReserve && !deliversCompatibleFuel) continue;

      const dst = world.locations[dstId];
      const dstTarget = dst.targetStock[goodId] ?? 0;
      const dstStockNow = dstMarket.stock[goodId] ?? 0;
      const inflightToDst = inflightMap.get(`${dstId}|${goodId}`) ?? 0;
      const dstStockAtArrival = dstStockNow + INFLIGHT_WEIGHT * inflightToDst;
      const grossSellPrice = dstTarget > 0
        ? priceFor(world.goods[goodId].basePrice, dstStockAtArrival, dstTarget)
        : dstMarket.prices[goodId];
      const sellPrice = grossSellPrice * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * localFuelPrice;
      const grossProfitPerUnit = sellPrice - buyPrice - fuelCost / maxQty;
      if (grossProfitPerUnit <= 0) continue;

      const travelTicks = Math.max(1, Math.ceil(dist / trader.speed));
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

  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return [];
  const here = trader.location;
  const hereMarket = world.markets[here];
  const localFuelPrice = hereMarket.prices[fuel.good] ?? 0;
  const out: SpeculativeOption[] = [];

  // Sort candidate via-points by distance and only consider the K nearest.
  // Long empty trips rarely repay their positioning cost anyway.
  const candidates = reachableNeighbors(world, here)
    .map(n => ({ id: n.to, dist: n.dist }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, SPECULATIVE_NEAREST_K);

  const perDist = effectivePerDistance(trader, ft.perDistance);
  for (const { id: viaId, dist } of candidates) {
    const emptyFuelNeeded = dist * perDist;
    if (emptyFuelNeeded > fuel.qty) continue;

    // Need fuel at via (so we can refuel + continue) OR enough remaining
    // to skip the 2-leg plan. We require the via to have fuel — otherwise
    // the trader would arrive at via and be stuck.
    const viaMarket = world.markets[viaId];
    const viaHasMyFuel = trader.fuelTypes.some(
      f => (viaMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
    );
    if (!viaHasMyFuel) continue;

    const emptyTravelTicks = Math.max(1, Math.ceil(dist / trader.speed));
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
  const market = world.markets[dst];
  let value = 0;
  for (const lot of trader.cargo) {
    const sellNet = (market.prices[lot.good] ?? 0) * (1 - SALES_TAX_RATE);
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
  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return [];

  const hereMarket = world.markets[trader.location];
  const localFuelPrice = hereMarket.prices[fuel.good] ?? 0;
  const perDist = effectivePerDistance(trader, ft.perDistance);
  const cargoLoaded = trader.cargo.length > 0;

  const out: RepositionOption[] = [];
  for (const { to, dist } of reachableNeighbors(world, trader.location)) {
    const fuelNeeded = dist * perDist;
    if (fuelNeeded > fuel.qty + 0.001) continue;

    const dstMarket = world.markets[to];
    const fuelAfter = fuel.qty - fuelNeeded;
    const dstHasMyFuel = trader.fuelTypes.some(
      f => (dstMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
    );
    const safeReserve = fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
    const safeHop = dstHasMyFuel || safeReserve;
    if (!safeHop && !allowUnsafeHop) continue;

    const travelTicks = Math.max(1, Math.ceil(dist / trader.speed));
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

function departForReposition(trader: Trader, to: LocationId, fuelNeeded: number, travelTicks: number, events: TraderEvent[]): void {
  const here = trader.location;
  trader.currentFuel = { good: trader.currentFuel!.good, qty: trader.currentFuel!.qty - fuelNeeded };
  trader.destination = to;
  trader.state = "transit";
  trader.ticksRemaining = travelTicks;
  trader.noOpportunityTicks = 0;
  events.push({ trader: trader.id, kind: "depart", from: here, to });
}

function stepTrader(world: World, trader: Trader, events: TraderEvent[], inflight: Map<string, number>): void {
  if (trader.state === "transit") {
    trader.ticksRemaining -= 1;
    if (trader.ticksRemaining > 0) return;

    const dst = trader.destination!;
    trader.location = dst;
    trader.destination = null;
    trader.state = "idle";
    trader.noOpportunityTicks = 0;
    events.push({ trader: trader.id, kind: "arrive", to: dst });
    chargeDockingFee(trader);

    // Manual player ships do NOT auto-sell on arrival — cargo stays loaded
    // until the player clicks Sell. The hint engine highlights the Sell
    // button on arrival so the next-step CTA is obvious.
    if (trader.cargo.length > 0 && trader.pilot !== "manual") {
      // Auto-accept matching local contracts on arrival — but only if the
      // ship has a navigator on the crew. Without one, contracts must be
      // accepted manually by the player.
      if (trader.pilot === "auto" && hasCrew(trader, "navigator")) {
        const cargoGoods = new Set(trader.cargo.map(l => l.good));
        for (const job of Object.values(world.jobs)) {
          if (job.acceptedBy != null) continue;
          if (job.kind !== "shortage") continue;
          if (job.destination !== dst) continue;
          if (!cargoGoods.has(job.good)) continue;
          acceptJob(world, job.id, trader.id);
        }
      }

      const dstMarket = world.markets[dst];
      for (const lot of trader.cargo) {
        const { good, qty } = lot;
        const unitPrice = dstMarket.prices[good];
        dstMarket.stock[good] = (dstMarket.stock[good] ?? 0) + qty;
        const netUnitPrice = unitPrice * (1 - SALES_TAX_RATE);
        trader.funds += qty * netUnitPrice;
        events.push({ trader: trader.id, kind: "sell", good, qty, unitPrice: netUnitPrice, to: dst });
        // Credit any matching accepted contracts (player ships only — the
        // creditJobOnDelivery helper bails for non-player ids). Pays out the
        // contract reward + emits a job_completed log entry.
        creditJobOnDelivery(world, trader.id, dst, good, qty);
      }
      trader.cargo = [];
    }
    return;
  }

  if (trader.pilot === "manual") {
    trader.noOpportunityTicks = 0;
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  // Player ships in auto mode require a captain on the crew. Without one
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

  tryRefuel(world, trader, events);
  restoreNpcOperatingFloat(world, trader);

  const choice = evaluateOptions(world, trader, inflight);
  if (!choice) {
    // No direct trade — try speculative travel: empty trip to a station
    // where a profitable trade exists, even after positioning costs.
    if (trader.cargo.length === 0) {
      const speculative = listSpeculativeOptions(world, trader, playerDrawFraction(world, trader));
      const sp = speculative[0];
      if (sp) {
        // Depart empty for the via point. On arrival, refuel + take the
        // best trade from there (which we'll re-evaluate next tick).
        departForReposition(trader, sp.via, sp.emptyFuelNeeded, sp.emptyTravelTicks, events);
        return;
      }
    }

    trader.noOpportunityTicks = (trader.noOpportunityTicks ?? 0) + 1;
    if (trader.noOpportunityTicks >= MAX_NO_OPPORTUNITY_TICKS) {
      const emergencyHop = selectRefuelType(world, trader) == null;
      const reposition = listRepositionOptions(world, trader, emergencyHop)[0];
      if (reposition) {
        departForReposition(trader, reposition.to, reposition.fuelNeeded, reposition.travelTicks, events);
        return;
      }
    }
    events.push({ trader: trader.id, kind: isStuck(world, trader) ? "stuck" : "idle" });
    return;
  }

  trader.noOpportunityTicks = 0;
  const here = trader.location;
  const srcMarket = world.markets[here];

  // Navigator-only multi-good loadout: before the primary buy, pre-load goods
  // for any accepted contract bound for the same destination. Solves the
  // case where the engine picks a high-margin generic trade and would
  // otherwise abandon a parallel accepted contract that could have ridden
  // along in the same trip. Contract goods load FIRST (high-tier first),
  // primary fills the remaining bay.
  const canPreloadContracts = isPlayerShip(world, trader)
    && trader.pilot === "auto"
    && hasCrew(trader, "navigator");
  const tierRank = { high: 0, medium: 1, low: 2 } as const;
  const contractLoads: { good: GoodId; qty: number; price: number }[] = [];
  let preloadMass = 0;
  let fundsLeft = trader.funds;
  if (canPreloadContracts) {
    const accs = Object.values(world.jobs)
      .filter(j => j.acceptedBy === trader.id && j.destination === choice.to && j.good !== choice.good)
      .sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);
    for (const c of accs) {
      const remaining = c.qty - c.delivered;
      if (remaining <= 0) continue;
      const g = world.goods[c.good];
      if (!g) continue;
      const stock = srcMarket.stock[c.good] ?? 0;
      const price = srcMarket.prices[c.good] ?? 0;
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
    trader.funds -= l.qty * l.price;
    trader.cargo.push({ good: l.good, qty: l.qty, source: here, unitPrice: l.price, purchasedAt: world.tick });
    events.push({ trader: trader.id, kind: "buy", good: l.good, qty: l.qty, unitPrice: l.price, from: here });
  }
  if (primaryQty > 0) {
    srcMarket.stock[choice.good] = (srcMarket.stock[choice.good] ?? 0) - primaryQty;
    trader.funds -= primaryQty * choice.buyPrice;
    trader.cargo.push({ good: choice.good, qty: primaryQty, source: here, unitPrice: choice.buyPrice, purchasedAt: world.tick });
    events.push({ trader: trader.id, kind: "buy", good: choice.good, qty: primaryQty, unitPrice: choice.buyPrice, from: here });
  }

  trader.currentFuel = { good: trader.currentFuel!.good, qty: trader.currentFuel!.qty - choice.fuelNeeded };
  trader.destination = choice.to;
  trader.state = "transit";
  trader.ticksRemaining = choice.travelTicks;
  trader.noOpportunityTicks = 0;
  events.push({ trader: trader.id, kind: "depart", from: here, to: choice.to });

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
  const blocked = maintenanceTravelBlockReason(trader);
  if (blocked) return { ok: false, reason: blocked };

  const here = trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const ft = activeFuelType(trader);
  if (!fuel || !ft) return { ok: false, reason: "No compatible fuel in tank." };
  const dist = routeDistance(world, here, choice.to);
  if (dist == null) return { ok: false, reason: "No plotted route to destination." };
  const fuelNeeded = dist * effectivePerDistance(trader, ft.perDistance);
  if (fuel.qty < fuelNeeded - 0.001) return { ok: false, reason: "Not enough fuel for this trip." };
  if (trader.funds < choice.qty * choice.buyPrice) return { ok: false, reason: "Not enough funds to buy this cargo." };

  const stockHere = srcMarket.stock[choice.good] ?? 0;
  if (stockHere < choice.qty) return { ok: false, reason: `Source has only ${stockHere.toFixed(0)} of ${choice.good}.` };

  const goodWeight = world.goods[choice.good].weight;
  const currentMass = trader.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
  const addMass = choice.qty * goodWeight;
  if (currentMass + addMass > trader.capacity + 0.001) {
    return { ok: false, reason: "Not enough cargo space." };
  }

  const events: TraderEvent[] = [];

  srcMarket.stock[choice.good] = stockHere - choice.qty;
  trader.funds -= choice.qty * choice.buyPrice;
  addCargoLot(trader, choice.good, choice.qty, here, choice.buyPrice, world.tick);
  trader.currentFuel = { good: fuel.good, qty: fuel.qty - fuelNeeded };
  events.push({
    trader: trader.id,
    kind: "buy",
    good: choice.good,
    qty: choice.qty,
    unitPrice: choice.buyPrice,
    from: here,
  });

  trader.destination = choice.to;
  trader.state = "transit";
  trader.ticksRemaining = Math.max(1, Math.ceil(dist / trader.speed));
  events.push({ trader: trader.id, kind: "depart", from: here, to: choice.to });

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
  return trader.cargo.reduce((s, l) => s + l.qty * (world.goods[l.good]?.weight ?? 0), 0);
}

function replacedUpgradeCargoPrice(world: World, trader: Trader, goodId: GoodId): number {
  return world.markets[trader.location]?.prices[goodId] ?? world.goods[goodId]?.basePrice ?? 0;
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
  if (trader.upgrades?.[def.slot] === goodId) return { ok: false, reason: `${def.name} is already installed.` };
  if (cargoQty(trader, goodId) < 1 - 0.001) return { ok: false, reason: `No ${def.name} in cargo.` };

  const snap = snapshotUpgradeInstall(trader);
  const previous = trader.upgrades?.[def.slot];

  removeCargoUnit(trader, goodId);
  trader.upgrades = { ...(trader.upgrades ?? {}), [def.slot]: goodId };
  if (previous) {
    addCargoLot(trader, previous, 1, trader.location, replacedUpgradeCargoPrice(world, trader, previous), world.tick);
  }

  const result = finalizeUpgradeInstall(world, trader, goodId, previous);
  if (!result.ok) restoreUpgradeInstall(trader, snap);
  return result;
}

export function installUpgradeFromMarket(world: World, trader: Trader, goodId: GoodId): UpgradeInstallResult {
  if (trader.state !== "idle") return { ok: false, reason: "Can only install upgrades while docked." };
  const def = upgradeDef(goodId);
  if (!def) return { ok: false, reason: "That good is not a ship upgrade." };
  if (trader.upgrades?.[def.slot] === goodId) return { ok: false, reason: `${def.name} is already installed.` };

  const market = world.markets[trader.location];
  const stock = market.stock[goodId] ?? 0;
  if (stock < 1) return { ok: false, reason: `${def.name} is not in stock here.` };
  const price = market.prices[goodId] ?? world.goods[goodId]?.basePrice ?? 0;
  if (trader.funds < price - 0.001) {
    return { ok: false, reason: `Need Ç${price.toFixed(0)}, have Ç${trader.funds.toFixed(0)}.` };
  }

  const snap = snapshotUpgradeInstall(trader);
  const previous = trader.upgrades?.[def.slot];
  const stockBefore = stock;

  market.stock[goodId] = stock - 1;
  trader.funds -= price;
  trader.upgrades = { ...(trader.upgrades ?? {}), [def.slot]: goodId };
  if (previous) {
    addCargoLot(trader, previous, 1, trader.location, replacedUpgradeCargoPrice(world, trader, previous), world.tick);
  }

  const result = finalizeUpgradeInstall(world, trader, goodId, previous);
  if (!result.ok) {
    restoreUpgradeInstall(trader, snap);
    market.stock[goodId] = stockBefore;
  }
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
  const currentMass = trader.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
  const addMass = qty * good.weight;
  if (currentMass + addMass > trader.capacity + 0.001) {
    const room = Math.max(0, (trader.capacity - currentMass) / good.weight);
    return { ok: false, reason: `Not enough cargo space. Max additional: ${Math.floor(room)} ${goodId}.` };
  }

  const price = market.prices[goodId];
  const cost = qty * price;
  if (trader.funds < cost - 0.001) return { ok: false, reason: `Need Ç${cost.toFixed(0)}, have Ç${trader.funds.toFixed(0)}.` };

  market.stock[goodId] = stock - qty;
  trader.funds -= cost;
  addCargoLot(trader, goodId, qty, trader.location, price, world.tick);

  const events: TraderEvent[] = [{ trader: trader.id, kind: "buy", good: goodId, qty, unitPrice: price, from: trader.location }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
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

  const market = world.markets[trader.location];
  const grossPrice = market.prices[goodId];
  const netPrice = grossPrice * (1 - SALES_TAX_RATE);
  const revenue = sellQty * netPrice;

  market.stock[goodId] = (market.stock[goodId] ?? 0) + sellQty;
  trader.funds += revenue;

  // Drain matching lots FIFO until sellQty is satisfied. Remove emptied lots.
  let remaining = sellQty;
  const toRemove: number[] = [];
  for (const { lot, idx } of matching) {
    if (remaining <= 0.001) break;
    const take = Math.min(lot.qty, remaining);
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= 0.001) toRemove.push(idx);
  }
  // Remove emptied lots in reverse order so indices stay valid.
  toRemove.sort((a, b) => b - a).forEach(i => trader.cargo.splice(i, 1));

  const jobCompletions = creditJobOnDelivery(world, trader.id, trader.location, goodId, sellQty);

  const events: TraderEvent[] = [{ trader: trader.id, kind: "sell", good: goodId, qty: sellQty, unitPrice: netPrice, to: trader.location }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
  // Job completion entries are pushed inside creditJobOnDelivery while it
  // still has the live job object — nothing to do here.
  return { ok: true, events, jobCompletions };
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
  trader.funds -= buyQty * price;
  trader.currentFuel = { good: ft.good, qty: currentQty + buyQty };

  const events: TraderEvent[] = [{ trader: trader.id, kind: "refuel", good: ft.good, qty: buyQty, unitPrice: price }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
  return { ok: true, events };
}

export function travelTo(world: World, trader: Trader, dst: LocationId): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is already in transit." };
  if (dst === trader.location) return { ok: false, reason: "Already at destination." };
  if (!world.locations[dst]) return { ok: false, reason: "Unknown destination." };

  const blocked = maintenanceTravelBlockReason(trader);
  if (blocked) return { ok: false, reason: blocked };

  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return { ok: false, reason: "No compatible fuel in tank." };

  const dist = routeDistance(world, trader.location, dst);
  if (dist == null) return { ok: false, reason: "No plotted route to destination." };
  const fuelNeeded = dist * effectivePerDistance(trader, ft.perDistance);
  if (fuel.qty < fuelNeeded - 0.001) {
    return { ok: false, reason: `Need ${fuelNeeded.toFixed(1)} fuel, have ${fuel.qty.toFixed(1)}.` };
  }

  const travelTicks = Math.max(1, Math.ceil(dist / trader.speed));

  trader.currentFuel = { good: fuel.good, qty: fuel.qty - fuelNeeded };
  trader.destination = dst;
  trader.state = "transit";
  trader.ticksRemaining = travelTicks;

  const events: TraderEvent[] = [{ trader: trader.id, kind: "depart", from: trader.location, to: dst }];
  for (const ev of events) pushTraderEvent(world, trader, ev);
  return { ok: true, events };
}

// Pay off accumulated maintenance debt. Player-only — debt only accrues for
// player ships missing a mechanic. Charged to the ship's own wallet.
export function repairShip(world: World, trader: Trader): { ok: true; paid: number } | { ok: false; reason: string } {
  if (trader.state !== "idle") return { ok: false, reason: "Can only repair while docked." };
  const debt = trader.maintenanceDebt ?? 0;
  if (debt <= 0) return { ok: false, reason: "Ship is in good repair — nothing to fix." };
  if (trader.funds < debt) {
    return { ok: false, reason: `Need Ç${Math.round(debt).toLocaleString()} to repair, ship has Ç${Math.round(trader.funds).toLocaleString()}.` };
  }
  trader.funds -= debt;
  trader.maintenanceDebt = 0;
  pushNote(world, trader, `Repaired ship — Ç${Math.round(debt).toLocaleString()} paid`, "good");
  return { ok: true, paid: debt };
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
