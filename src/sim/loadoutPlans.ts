import type { FuelType, GoodId, Job, JobId, LocationId, Trader, World } from "./types";
import { reachableNeighbors } from "./geometry";
import {
  DOCKING_FEE_PER_CAPACITY,
  MAINTENANCE_PER_CAPACITY,
  SALES_TAX_RATE,
} from "./economy";
import { effectivePerDistance, ignoresFuel, MAINTENANCE_DEBT_TRAVEL_BLOCK, travelTicksFor } from "./crew";
import { listAvailableRescueJobs, listLocalJobs } from "./jobs";

export interface PlannedBuy {
  good: GoodId;
  qty: number;
  reason: "contract" | "trade";
}

export interface PlannedSell {
  good: GoodId;
  qty: number;
}

export interface RoutePlanCandidate {
  value: number;
  dst: LocationId;
  buys: PlannedBuy[];
  acceptJobIds: JobId[];
  expectedNet: number;
  ticks: number;
  reason: string;
  futureBuys?: PlannedBuy[];
  loaded?: PlannedSell[];
}

const PLAN_FILLER_GOOD_LIMIT = 4;
const FUEL_POST_TRADE_MIN = 0.30;
const JOB_TIER_PRIORITY = { high: 0, medium: 1, low: 2 } as const;

type CargoJob = Job & { good: GoodId };

function hasJobGood(job: Job): job is CargoJob {
  return job.kind !== "trade" && job.good != null;
}

function activeFuelType(ship: Trader): FuelType | null {
  if (!ship.currentFuel) return null;
  return ship.fuelTypes.find(f => f.good === ship.currentFuel!.good) ?? null;
}

function hasMaintenanceTravelBlock(ship: Trader): boolean {
  return (ship.maintenanceDebt ?? 0) >= MAINTENANCE_DEBT_TRAVEL_BLOCK;
}

function addPlannedBuy(buys: PlannedBuy[], good: GoodId, qty: number, reason: PlannedBuy["reason"]): void {
  if (qty <= 0) return;
  const existing = buys.find(b => b.good === good && b.reason === reason);
  if (existing) existing.qty += qty;
  else buys.push({ good, qty, reason });
}

function plannedQtyList(items: { good: GoodId; qty: number }[], world: World): string {
  return items
    .map(b => `${Math.floor(b.qty)} ${world.goods[b.good]?.name ?? b.good}`)
    .join(", ");
}

function plannedBuyList(buys: PlannedBuy[], world: World): string {
  return plannedQtyList(buys, world);
}

function cargoMassFor(items: { good: GoodId; qty: number }[], world: World): number {
  return items.reduce((sum, item) => sum + item.qty * (world.goods[item.good]?.weight ?? 0), 0);
}

function cargoByGood(ship: Trader): Map<GoodId, { qty: number; cost: number }> {
  const out = new Map<GoodId, { qty: number; cost: number }>();
  for (const lot of ship.cargo) {
    const entry = out.get(lot.good) ?? { qty: 0, cost: 0 };
    entry.qty += lot.qty;
    entry.cost += lot.qty * lot.unitPrice;
    out.set(lot.good, entry);
  }
  return out;
}

function contractUnitValue(job: Job, ship: Trader): number {
  return (job.reward + (job.acceptedBy === ship.id ? job.penalty : 0)) / job.qty;
}

function travelProfile(world: World, ship: Trader, dst: LocationId): {
  dist: number;
  fuelNeeded: number;
  travelTicks: number;
  travelCost: number;
} | null {
  if (hasMaintenanceTravelBlock(ship)) return null;
  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
  const fuel = ship.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return null;

  const reachable = reachableNeighbors(world, ship.location).find(n => n.to === dst);
  if (!reachable) return null;

  const perDist = fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance);
  const fuelNeeded = reachable.dist * perDist;
  if (!fuelFree && fuelNeeded > fuel!.qty) return null;

  const dstMarket = world.markets[dst];
  const fuelAfter = fuelFree ? ship.fuelCapacity : fuel!.qty - fuelNeeded;
  const dstHasMyFuel = fuelFree || ship.fuelTypes.some(
    f => (dstMarket.stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4,
  );
  const safeReserve = fuelFree || fuelAfter >= ship.fuelCapacity * FUEL_POST_TRADE_MIN;
  if (!dstHasMyFuel && !safeReserve) return null;

  const hereMarket = world.markets[ship.location];
  const fuelGood = fuel?.good ?? ft?.good;
  const fuelPrice = fuelGood ? hereMarket.prices[fuelGood] ?? 0 : 0;
  const travelTicks = travelTicksFor(ship, reachable.dist);
  const fuelCost = fuelNeeded * fuelPrice;
  const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
  const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
  return {
    dist: reachable.dist,
    fuelNeeded,
    travelTicks,
    travelCost: fuelCost + tripMaint + dockingFee,
  };
}

export function buildDestinationLoadoutPlans(world: World, ship: Trader, drawFraction: number): RoutePlanCandidate[] {
  if (hasMaintenanceTravelBlock(ship)) return [];
  const hereMarket = world.markets[ship.location];
  const usedMass = ship.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
  const freeMassBase = Math.max(0, ship.capacity - usedMass);

  const visibleRescues = listAvailableRescueJobs(world);
  const loadedCargo = cargoByGood(ship);
  const out: RoutePlanCandidate[] = [];

  for (const { to: dstId } of reachableNeighbors(world, ship.location)) {
    const profile = travelProfile(world, ship, dstId);
    if (!profile) continue;

    let freeMass = freeMassBase;
    let fundsLeft = ship.funds;
    let grossValue = 0;
    let loadedValue = 0;
    const buys: PlannedBuy[] = [];
    const loaded: PlannedSell[] = [];
    const acceptJobIdSet = new Set<JobId>();
    const loadedContractCredit = new Map<JobId, number>();
    const stockLeft = new Map<GoodId, number>();
    const stockFor = (good: GoodId) => stockLeft.get(good) ?? (hereMarket.stock[good] ?? 0);
    const spendStock = (good: GoodId, qty: number) => stockLeft.set(good, Math.max(0, stockFor(good) - qty));

    const jobs = Object.values(world.jobs)
      .filter((j): j is CargoJob =>
        hasJobGood(j)
        && j.destination === dstId
        && (j.acceptedBy === ship.id || (j.acceptedBy == null && j.kind === "rescue" && visibleRescues.includes(j)))
      )
      .sort((a, b) =>
        Number(b.acceptedBy === ship.id) - Number(a.acceptedBy === ship.id)
        || JOB_TIER_PRIORITY[a.tier] - JOB_TIER_PRIORITY[b.tier]
        || a.expiresAt - b.expiresAt,
      );

    for (const [goodId, cargo] of loadedCargo) {
      const dstNet = (world.markets[dstId].prices[goodId] ?? 0) * (1 - SALES_TAX_RATE);
      let uncredited = cargo.qty;
      let contractBonus = 0;

      for (const job of jobs) {
        if (job.good !== goodId || uncredited <= 0) continue;
        const remaining = job.qty - job.delivered - (loadedContractCredit.get(job.id) ?? 0);
        if (remaining <= 0) continue;
        const credited = Math.min(uncredited, remaining);
        loadedContractCredit.set(job.id, (loadedContractCredit.get(job.id) ?? 0) + credited);
        contractBonus += credited * contractUnitValue(job, ship);
        uncredited -= credited;
        if (job.acceptedBy == null) acceptJobIdSet.add(job.id);
      }

      const value = cargo.qty * dstNet - cargo.cost + contractBonus;
      if (value > 0 || contractBonus > 0) {
        loaded.push({ good: goodId, qty: cargo.qty });
        loadedValue += value;
      }
    }

    for (const job of jobs) {
      const good = world.goods[job.good];
      if (!good) continue;
      const remaining = job.qty - job.delivered - (loadedContractCredit.get(job.id) ?? 0);
      if (remaining <= 0) continue;
      const stock = stockFor(job.good);
      if (stock < 1) continue;
      const buyPrice = hereMarket.prices[job.good] ?? 0;
      const maxByMass = Math.floor(freeMass / good.weight);
      const maxByFunds = buyPrice > 0 ? Math.floor(fundsLeft / buyPrice) : 0;
      const qty = Math.max(0, Math.min(remaining, Math.floor(stock), maxByMass, maxByFunds));
      if (qty < 1) continue;

      const dstNet = (world.markets[dstId].prices[job.good] ?? 0) * (1 - SALES_TAX_RATE);
      const contractUnit = (job.reward + (job.acceptedBy === ship.id ? job.penalty : 0)) / job.qty;
      grossValue += qty * (dstNet - buyPrice + contractUnit);
      fundsLeft -= qty * buyPrice;
      freeMass -= qty * good.weight;
      spendStock(job.good, qty);
      addPlannedBuy(buys, job.good, qty, "contract");
      if (job.acceptedBy == null) acceptJobIdSet.add(job.id);
    }

    const filler = freeMass > 0.001 ? (Object.keys(world.goods) as GoodId[])
      .map(goodId => {
        const good = world.goods[goodId];
        const stock = stockFor(goodId);
        const buyPrice = hereMarket.prices[goodId] ?? 0;
        const dstNet = (world.markets[dstId].prices[goodId] ?? 0) * (1 - SALES_TAX_RATE);
        const unitNet = dstNet - buyPrice;
        return { goodId, good, stock, buyPrice, unitNet, perMass: good.weight > 0 ? unitNet / good.weight : unitNet };
      })
      .filter(x => x.stock >= 1 && x.unitNet > 0)
      .sort((a, b) => b.perMass - a.perMass)
      .slice(0, PLAN_FILLER_GOOD_LIMIT) : [];

    for (const f of filler) {
      if (freeMass <= 0.001 || fundsLeft <= 0.001) break;
      const maxByMass = Math.floor(freeMass / f.good.weight);
      const maxByStock = Math.floor(f.stock * drawFraction);
      const maxByFunds = f.buyPrice > 0 ? Math.floor(fundsLeft / f.buyPrice) : 0;
      const qty = Math.max(0, Math.min(maxByMass, maxByStock, maxByFunds));
      if (qty < 1) continue;
      grossValue += qty * f.unitNet;
      fundsLeft -= qty * f.buyPrice;
      freeMass -= qty * f.good.weight;
      spendStock(f.goodId, qty);
      addPlannedBuy(buys, f.goodId, qty, "trade");
    }

    if (buys.length === 0 && loaded.length === 0) continue;
    const acceptJobIds = [...acceptJobIdSet];
    const expectedNet = loadedValue + grossValue - profile.travelCost;
    if (expectedNet <= 0) continue;
    const continuingLoadout = loaded.length > 0 && (buys.length > 0 || acceptJobIds.length > 0 || loaded.length > 1);
    if (buys.length < 2 && acceptJobIds.length === 0 && !continuingLoadout) continue;

    const dstName = world.locations[dstId]?.name ?? dstId;
    const steps: string[] = [];
    if (acceptJobIds.length > 0) steps.push(`accept ${acceptJobIds.length} broadcast rescue${acceptJobIds.length === 1 ? "" : "s"}`);
    if (loaded.length > 0) steps.push(`keep ${plannedQtyList(loaded, world)} onboard`);
    if (buys.length > 0) steps.push(`${loaded.length > 0 ? "add" : "load"} ${plannedBuyList(buys, world)}`);
    steps.push(`fly to ${dstName}`);
    const planText = steps.join(" -> ");
    const finalCargoMass = Math.min(ship.capacity, usedMass + cargoMassFor(buys, world));
    const cargoText = buys.length > 1
      ? ` Highlighted buys share the same cargo bay; planned cargo mass ${Math.round(finalCargoMass)}/${ship.capacity}.`
      : "";
    const reason = `${planText.charAt(0).toUpperCase()}${planText.slice(1)}. Estimated net Ç${Math.round(expectedNet).toLocaleString()} over ${profile.travelTicks + 1} ticks.${cargoText}`;
    out.push({
      value: expectedNet,
      dst: dstId,
      buys,
      acceptJobIds,
      expectedNet,
      ticks: profile.travelTicks + 1,
      reason,
      loaded,
    });
  }

  return out;
}

export function buildLocalFetchPlans(world: World, ship: Trader): RoutePlanCandidate[] {
  const openJobs = listLocalJobs(world, ship.location).filter(hasJobGood);
  const acceptedJobs = Object.values(world.jobs).filter((j): j is CargoJob =>
    hasJobGood(j)
    && j.acceptedBy === ship.id
    && j.destination === ship.location
  );
  const jobs = [...acceptedJobs, ...openJobs];
  const fetchable = jobs
    .filter(job => ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0) <= 0)
    .sort((a, b) => JOB_TIER_PRIORITY[a.tier] - JOB_TIER_PRIORITY[b.tier] || a.expiresAt - b.expiresAt);
  if (fetchable.length === 0) return [];

  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
  const fuel = ship.currentFuel;
  if (((!ft || !fuel) && !fuelFree) || hasMaintenanceTravelBlock(ship)) return [];

  const hereMarket = world.markets[ship.location];
  const perDist = fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance);
  const fuelGood = fuel?.good ?? ft?.good;
  const fuelPriceHere = fuelGood ? hereMarket.prices[fuelGood] ?? 0 : 0;
  const out: RoutePlanCandidate[] = [];

  for (const { to: srcId, dist } of reachableNeighbors(world, ship.location)) {
    const outFuelNeeded = dist * perDist;
    if (!fuelFree && outFuelNeeded > fuel!.qty) continue;
    const returnFuelNeeded = outFuelNeeded;
    const fuelRemainingAtSource = fuelFree ? ship.fuelCapacity : fuel!.qty - outFuelNeeded;
    const fuelDeficitForReturn = Math.max(0, returnFuelNeeded - fuelRemainingAtSource);
    const srcMarket = world.markets[srcId];
    const srcFuelStock = fuelGood ? srcMarket.stock[fuelGood] ?? 0 : 0;
    const fuelPriceSrc = fuelGood ? srcMarket.prices[fuelGood] ?? fuelPriceHere : 0;
    if (!fuelFree && fuelDeficitForReturn > 0.001 && srcFuelStock < fuelDeficitForReturn) continue;

    let freeMass = ship.capacity;
    let fundsLeft = ship.funds - fuelDeficitForReturn * fuelPriceSrc;
    if (fundsLeft <= 0) continue;
    let grossValue = 0;
    const futureBuys: PlannedBuy[] = [];
    const acceptJobIds: JobId[] = [];
    let acceptedLocalCount = 0;
    const stockLeft = new Map<GoodId, number>();
    const stockFor = (good: GoodId) => stockLeft.get(good) ?? (srcMarket.stock[good] ?? 0);
    const spendStock = (good: GoodId, qty: number) => stockLeft.set(good, Math.max(0, stockFor(good) - qty));

    for (const job of fetchable) {
      const good = world.goods[job.good];
      if (!good) continue;
      const stockReservedForReturnFuel = !fuelFree && job.good === fuelGood ? fuelDeficitForReturn : 0;
      const stock = Math.max(0, stockFor(job.good) - stockReservedForReturnFuel);
      if (stock < 1) continue;
      const srcPrice = srcMarket.prices[job.good] ?? 0;
      const maxByMass = Math.floor(freeMass / good.weight);
      const maxByFunds = srcPrice > 0 ? Math.floor(fundsLeft / srcPrice) : 0;
      const qty = Math.max(0, Math.min(job.qty, Math.floor(stock), maxByMass, maxByFunds));
      if (qty < 1) continue;
      const dstNet = (hereMarket.prices[job.good] ?? 0) * (1 - SALES_TAX_RATE);
      const bonus = contractUnitValue(job, ship);
      grossValue += qty * (dstNet - srcPrice + bonus);
      fundsLeft -= qty * srcPrice;
      freeMass -= qty * good.weight;
      spendStock(job.good, qty);
      addPlannedBuy(futureBuys, job.good, qty, "contract");
      if (job.acceptedBy == null) acceptJobIds.push(job.id);
      else acceptedLocalCount += 1;
    }

    if (futureBuys.length === 0) continue;
    const oneWayTicks = travelTicksFor(ship, dist);
    const outFuelCost = outFuelNeeded * fuelPriceHere;
    const existingFuelForReturn = Math.min(returnFuelNeeded, Math.max(0, fuelRemainingAtSource));
    const returnFuelCost = existingFuelForReturn * fuelPriceHere + fuelDeficitForReturn * fuelPriceSrc;
    const tripMaint = oneWayTicks * 2 * ship.capacity * MAINTENANCE_PER_CAPACITY;
    const dockingFees = ship.capacity * DOCKING_FEE_PER_CAPACITY * 2;
    const expectedNet = grossValue - outFuelCost - returnFuelCost - tripMaint - dockingFees;
    if (expectedNet <= 0) continue;

    const srcName = world.locations[srcId]?.name ?? srcId;
    out.push({
      value: expectedNet,
      dst: srcId,
      buys: [],
      futureBuys,
      acceptJobIds,
      expectedNet,
      ticks: oneWayTicks * 2 + 1,
      reason: `${acceptJobIds.length > 0 ? `Accept ${acceptJobIds.length} remaining local contract${acceptJobIds.length === 1 ? "" : "s"} -> ` : ""}${acceptedLocalCount > 0 ? `keep ${acceptedLocalCount} active local contract${acceptedLocalCount === 1 ? "" : "s"} in plan -> ` : ""}fly to ${srcName} -> buy ${plannedBuyList(futureBuys, world)} -> return and deliver. Estimated net Ç${Math.round(expectedNet).toLocaleString()} over ${oneWayTicks * 2 + 1} ticks.`,
    });
  }

  return out;
}
