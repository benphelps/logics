import type { GoodId, Job, JobId, LocationId, Trader, World } from "./types";
import { reachableNeighbors, routeDistance } from "./geometry";
import { marketQuote, priceFor } from "./pricing";
import { activeFuelType, listSpeculativeOptions, listTradeOptions, maintenanceTravelBlockReason, refuelManual, selectRefuelType, sellAtLocation, type TradeOption } from "./traders";
import { acceptJob, listAvailableRescueJobs, listLocalJobs } from "./jobs";
import { effectivePerDistance, hasCrew } from "./crew";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";

export interface PlannedBuy {
  good: GoodId;
  qty: number;
  reason: "contract" | "trade";
}

export interface PlannedSell {
  good: GoodId;
  qty: number;
}

export type GuidedHint =
  | { kind: "buy_for_route"; good: GoodId; qty: number; dst: LocationId; netProfit: number; ticks: number; profitPerTick: number; jobId?: JobId; jobAccepted?: boolean }
  | { kind: "travel_to_sell"; dst: LocationId; good: GoodId; qty: number; expectedNet: number; gainOverHere: number; ticks: number; jobId?: JobId; jobAccepted?: boolean }
  | { kind: "sell_here"; good: GoodId; qty: number; revenue: number; jobId?: JobId }
  | { kind: "refuel"; critical: boolean; reason: string }
  | { kind: "speculate"; via: LocationId; thenBuy: GoodId; thenSellAt: LocationId; netProfit: number; ticks: number }
  | { kind: "accept_job"; jobId: JobId; reason: string; expectedNet: number; ticks: number }
  | { kind: "route_plan"; dst: LocationId; buys: PlannedBuy[]; acceptJobIds: JobId[]; expectedNet: number; ticks: number; reason: string; futureBuys?: PlannedBuy[]; loaded?: PlannedSell[] }
  | { kind: "job_plan"; acceptJobIds: JobId[]; sells: PlannedSell[]; expectedNet: number; ticks: number; reason: string }
  | { kind: "wait"; reason: string };

const FUEL_LOW_FRACTION = 0.50;          // refuel proactively below this when local fuel exists
const FUEL_CRITICAL_FRACTION = 0.15;     // override anything else below this
const FUEL_POST_TRADE_MIN = 0.30;        // if a trade would leave you below this and you can refuel here, refuel first
const PLAN_FILLER_GOOD_LIMIT = 4;
const LOCAL_SELL_EXIT_MIN_VALUE = 0.5;
const JOB_TIER_PRIORITY = { high: 0, medium: 1, low: 2 } as const;

type Candidate = { value: number; hint: GuidedHint };
type GuidedHintMode = "advisory" | "actual";

export interface GuidedPlan {
  current: GuidedHint;
  hints: GuidedHint[];
}

interface TravelFuelIntent {
  dst: LocationId;
  dstName: string;
  fuelNeeded: number;
  fuelAfter: number;
  dstHasFuel: boolean;
}

function isPlayerShip(world: World, ship: Trader): boolean {
  return world.player?.shipIds.includes(ship.id) ?? false;
}

function canRealizeUnacceptedContracts(world: World, ship: Trader): boolean {
  return isPlayerShip(world, ship)
    && (ship.pilot === "manual" || (ship.pilot === "auto" && hasCrew(ship, "captain")));
}

function canAffordRefuelHere(world: World, ship: Trader): boolean {
  const ft = selectRefuelType(world, ship);
  if (!ft) return false;
  const market = world.markets[ship.location];
  const stock = market.stock[ft.good] ?? 0;
  const price = market.prices[ft.good] ?? 0;
  const switching = !ship.currentFuel || ship.currentFuel.good !== ft.good;
  const currentQty = switching ? 0 : ship.currentFuel!.qty;
  const room = Math.max(0, ship.fuelCapacity - currentQty);
  const affordable = price > 0 ? ship.funds / price : 0;
  return Math.min(room, stock, affordable) > 0.001;
}

function buyHintFromTradeOption(option: TradeOption, acceptedJob?: Job): GuidedHint {
  return {
    kind: "buy_for_route",
    good: option.good,
    qty: option.qty,
    dst: option.to,
    netProfit: option.totalProfit,
    ticks: option.travelTicks + 1,
    profitPerTick: option.profitPerTick,
    jobId: option.jobId ?? acceptedJob?.id,
    jobAccepted: option.jobAccepted ?? (acceptedJob ? true : undefined),
  };
}

export function getGuidedHint(
  world: World,
  ship: Trader,
  options: { mode?: GuidedHintMode } = {},
): GuidedHint {
  if (ship.state === "transit") {
    return { kind: "wait", reason: `In transit to ${world.locations[ship.destination!]?.name ?? ship.destination}.` };
  }

  const playerShip = isPlayerShip(world, ship);
  const advisoryShip: Trader = playerShip && options.mode !== "actual" ? { ...ship, pilot: "manual" } : ship;
  const ft = activeFuelType(advisoryShip);
  const fuel = advisoryShip.currentFuel;
  const canRefuelHere = canAffordRefuelHere(world, advisoryShip);
  const travelBlocked = maintenanceTravelBlockReason(advisoryShip);

  // Critical fuel + fuel for sale here → refuel right now (override everything)
  if (fuel && ft) {
    const fraction = fuel.qty / advisoryShip.fuelCapacity;

    if (!travelBlocked && fraction < FUEL_CRITICAL_FRACTION && canRefuelHere) {
      return { kind: "refuel", critical: true, reason: `Tank at ${(fraction * 100).toFixed(0)}% — refuel before any move.` };
    }
  }

  // Consider both buy-here-and-travel options AND (if cargo is loaded) sell
  // and travel-to-sell options. Pick the single highest-value action across
  // all of them. This makes the engine "hedging-aware" — when the player has
  // partial cargo, the engine can suggest topping off with a different good
  // if that's the best move, instead of being stuck on the existing cargo.

  // Player guidance is mode-independent. Auto/manual changes who clicks the
  // action, not what the best advisory action should be.
  const drawFraction = playerShip ? 1.0 : advisoryShip.pilot === "manual" ? 1.0 : undefined;
  const buyOptions = listTradeOptions(world, advisoryShip, undefined, drawFraction);
  const cargoSell = advisoryShip.cargo.length > 0 ? cargoLoadedCandidates(world, advisoryShip) : [];

  // Pre-index the player's accepted jobs by (destination|good) for quick
  // lookup when scoring trade candidates. Jobs reward routes they target.
  const acceptedJobs = advisoryShip.pilot === "manual"
    ? Object.values(world.jobs).filter(j => j.acceptedBy === advisoryShip.id)
    : [];
  const jobByKey = new Map<string, typeof acceptedJobs[number]>();
  for (const j of acceptedJobs) jobByKey.set(`${j.destination}|${j.good}`, j);

  const candidates: Candidate[] = [];

  // In actual auto mode, mirror the autopilot executor's priority exactly:
  // it takes the best direct trade before considering empty repositioning.
  // Advisory mode can still compare full plans by total expected value.
  if (options.mode === "actual" && advisoryShip.pilot === "auto" && buyOptions[0]) {
    return buyHintFromTradeOption(buyOptions[0]);
  }

  for (const o of buyOptions) {
    // listTradeOptions already folds the contract bonus into totalProfit for
    // accepted jobs — we just tag the hint so the UI can show "fulfills an
    // active contract".
    const job = jobByKey.get(`${o.to}|${o.good}`);
    candidates.push({
      value: o.totalProfit,
      hint: buyHintFromTradeOption(o, job),
    });
  }
  // Boost cargo-loaded candidates if they fulfill a job. Accepted contracts
  // factor in the penalty-avoided so commitment carries weight (see
  // listTradeOptions for the same logic on buy_for_route).
  for (const c of cargoSell) {
    if (c.hint.kind === "travel_to_sell") {
      const job = jobByKey.get(`${c.hint.dst}|${c.hint.good}`);
      if (job) {
        const remaining = job.qty - job.delivered;
        const credited = Math.min(c.hint.qty, remaining);
        const bonus = credited * ((job.reward + job.penalty) / job.qty);
        c.value += bonus;
        c.hint.expectedNet += bonus;
        c.hint.gainOverHere += bonus;
        c.hint.jobId = job.id;
        c.hint.jobAccepted = true;
      }
    } else if (c.hint.kind === "sell_here") {
      const job = jobByKey.get(`${advisoryShip.location}|${c.hint.good}`);
      if (job) {
        const remaining = job.qty - job.delivered;
        const credited = Math.min(c.hint.qty, remaining);
        const bonus = credited * ((job.reward + job.penalty) / job.qty);
        c.value += bonus;
        c.hint.revenue += bonus;
        c.hint.jobId = job.id;
      }
    }
  }
  candidates.push(...cargoSell);

  // Local jobs the player hasn't accepted yet — accepting them is a costless
  // click, but the resulting plan (cargo-on-hand sell or round-trip fetch)
  // can carry significant value. Surface them as candidates so the engine
  // tells the player WHEN it's worth accepting.
  if (advisoryShip.pilot === "manual") {
    candidates.push(...localJobPlanCandidates(world, advisoryShip));
    candidates.push(...destinationLoadoutPlanCandidates(world, advisoryShip, drawFraction ?? 1));
    candidates.push(...localJobAcceptCandidates(world, advisoryShip));
  }

  // Speculative travel — only when cargo is empty (otherwise the player has
  // existing cargo to deal with first). Score against direct candidates.
  if (advisoryShip.cargo.length === 0) {
    for (const sp of listSpeculativeOptions(world, advisoryShip, drawFraction)) {
      candidates.push({
        value: sp.netProfit,
        hint: { kind: "speculate", via: sp.via, thenBuy: sp.thenBuy, thenSellAt: sp.thenSellAt, netProfit: sp.netProfit, ticks: sp.totalTicks },
      });
    }
  }

  candidates.sort((a, b) => b.value - a.value);

  // Honor-commitments override: if the player is standing on an accepted
  // contract's destination with cargo to fulfill it, suggest selling here
  // before anything else. The engine would otherwise pivot to a bigger
  // contract elsewhere — true higher EV but a worse UX (the local one can
  // close in one click for zero travel cost). Closing local commitments
  // first is almost never wrong.
  const localContractSell = candidates.find(c =>
    c.hint.kind === "sell_here"
    && c.hint.jobId != null
    && c.value > 0
  );
  if (localContractSell) {
    candidates.splice(candidates.indexOf(localContractSell), 1);
    candidates.unshift(localContractSell);
  }

  // Cargo that can already be sold at a profit should be cleared before the
  // engine suggests adding more goods or chaining into another route plan.
  // Otherwise the combined route scorer can keep the player hauling a mixed
  // cargo bay across several stations without an obvious cash-out step.
  const commitmentHint = candidates[0]?.hint.kind === "job_plan" || candidates[0]?.hint.kind === "accept_job";
  const localCargoSell = commitmentHint ? null : candidates.find(c =>
    c.hint.kind === "sell_here"
    && c.value > LOCAL_SELL_EXIT_MIN_VALUE
  );
  if (localCargoSell) {
    candidates.splice(candidates.indexOf(localCargoSell), 1);
    candidates.unshift(localCargoSell);
  }

  const top = candidates[0];

  // Pre-emptive refuel: if the player follows the top suggestion blindly and
  // would land critically low at a destination that may not have fuel,
  // suggest refueling FIRST (assuming current location does have fuel).
  // Without this, the engine happily walks the player into a stranding.
  if (fuel && ft && canRefuelHere && !travelBlocked) {
    const fraction = fuel.qty / advisoryShip.fuelCapacity;
    const travelIntent = top ? travelFuelIntent(world, advisoryShip, top.hint, buyOptions) : null;

    // If the chosen action involves travel, top off before leaving whenever
    // the tank is meaningfully low. This applies to route_plan too, so partial
    // multi-good loadouts do not bypass the old single-route fuel guard.
    if (fraction < FUEL_LOW_FRACTION && (!top || travelIntent)) {
      const suffix = travelIntent ? ` before flying to ${travelIntent.dstName}` : " before the next route";
      return { kind: "refuel", critical: false, reason: `Tank at ${(fraction * 100).toFixed(0)}% — top off${suffix}.` };
    }

    if (travelIntent && travelIntent.fuelAfter / advisoryShip.fuelCapacity < FUEL_POST_TRADE_MIN && !travelIntent.dstHasFuel) {
      return { kind: "refuel", critical: false, reason: `Refuel here first — that trip would leave you with only ${Math.max(0, travelIntent.fuelAfter).toFixed(0)} fuel at a station with no fuel for sale.` };
    }
  }

  if (top) return top.hint;

  if (travelBlocked) return { kind: "wait", reason: travelBlocked };

  if (fuel && fuel.qty <= 0.001) {
    if (selectRefuelType(world, advisoryShip) == null) {
      return { kind: "wait", reason: "Out of fuel and no compatible fuel for sale here. Wait for a trader to bring some, or summon help." };
    }
    return { kind: "wait", reason: "Out of fuel and can't afford compatible fuel here. Sell cargo if you can, or wait for help." };
  }

  // Fallback: no profitable trade and no refuel triggered
  return { kind: "wait", reason: "No profitable trades from here right now. Wait for prices to shift, or move on speculation." };
}

export function getGuidedPlan(
  world: World,
  ship: Trader,
  options: { mode?: GuidedHintMode } = {},
): GuidedPlan {
  const current = getGuidedHint(world, ship, options);
  const hints: GuidedHint[] = [current];
  if (!canExpandPlanAfter(current)) return { current, hints };

  const planWorld = structuredClone(world) as World;
  let planShip = planWorld.traders[ship.id];
  if (!planShip) return { current, hints };

  let lastKey = planHintKey(current);
  let next = current;
  for (let i = 0; i < 5; i++) {
    if (!applyPlanHint(planWorld, planShip, next)) break;
    planShip = planWorld.traders[ship.id];
    if (!planShip || planShip.state !== "idle") break;

    next = getGuidedHint(planWorld, planShip, options);
    const key = planHintKey(next);
    if (next.kind === "wait" || key === lastKey) break;
    hints.push(next);
    lastKey = key;
    if (!canExpandPlanAfter(next)) break;
  }

  return { current, hints };
}

function canExpandPlanAfter(hint: GuidedHint): boolean {
  return hint.kind === "sell_here"
    || hint.kind === "job_plan"
    || hint.kind === "accept_job"
    || hint.kind === "refuel";
}

function planHintKey(hint: GuidedHint): string {
  switch (hint.kind) {
    case "sell_here": return `${hint.kind}|${hint.good}|${Math.round(hint.qty)}`;
    case "job_plan": return `${hint.kind}|${hint.acceptJobIds.join(",")}|${hint.sells.map(s => `${s.good}:${Math.round(s.qty)}`).join(",")}`;
    case "accept_job": return `${hint.kind}|${hint.jobId}`;
    case "refuel": return `${hint.kind}|${hint.critical}`;
    case "buy_for_route": return `${hint.kind}|${hint.good}|${hint.dst}|${Math.round(hint.qty)}`;
    case "travel_to_sell": return `${hint.kind}|${hint.good}|${hint.dst}|${Math.round(hint.qty)}`;
    case "route_plan": return `${hint.kind}|${hint.dst}|${hint.buys.map(b => `${b.good}:${Math.round(b.qty)}`).join(",")}|${hint.futureBuys?.map(b => `${b.good}:${Math.round(b.qty)}`).join(",") ?? ""}`;
    case "speculate": return `${hint.kind}|${hint.via}|${hint.thenBuy}|${hint.thenSellAt}`;
    case "wait": return `${hint.kind}|${hint.reason}`;
  }
}

function applyPlanHint(world: World, ship: Trader, hint: GuidedHint): boolean {
  switch (hint.kind) {
    case "sell_here":
      return sellAtLocation(world, ship, hint.good, hint.qty).ok;
    case "job_plan": {
      let changed = false;
      for (const jobId of hint.acceptJobIds) {
        const result = acceptJob(world, jobId, ship.id);
        changed = result.ok || changed;
      }
      for (const sell of hint.sells) {
        const result = sellAtLocation(world, ship, sell.good, sell.qty);
        changed = result.ok || changed;
      }
      return changed;
    }
    case "accept_job":
      return acceptJob(world, hint.jobId, ship.id).ok;
    case "refuel":
      return refuelManual(world, ship).ok;
    default:
      return false;
  }
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

function travelFuelIntent(world: World, ship: Trader, hint: GuidedHint, buyOptions: TradeOption[]): TravelFuelIntent | null {
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  if (!ft || !fuel) return null;

  let dst: LocationId | null = null;
  let plannedFuelNeeded: number | null = null;
  if (hint.kind === "buy_for_route") {
    dst = hint.dst;
    plannedFuelNeeded = buyOptions.find(o => o.good === hint.good && o.to === hint.dst)?.fuelNeeded ?? null;
  } else if (hint.kind === "travel_to_sell") {
    dst = hint.dst;
  } else if (hint.kind === "route_plan") {
    dst = hint.dst;
  } else if (hint.kind === "speculate") {
    dst = hint.via;
  }
  if (!dst) return null;

  const directDist = routeDistance(world, ship.location, dst);
  if (directDist == null && plannedFuelNeeded == null) return null;
  const fuelNeeded = plannedFuelNeeded ?? directDist! * effectivePerDistance(ship, ft.perDistance);
  const fuelAfter = fuel.qty - fuelNeeded;
  const dstHasFuel = ship.fuelTypes.some(f => (world.markets[dst].stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4);
  return {
    dst,
    dstName: world.locations[dst]?.name ?? dst,
    fuelNeeded,
    fuelAfter,
    dstHasFuel,
  };
}

function travelProfile(world: World, ship: Trader, dst: LocationId): {
  dist: number;
  fuelNeeded: number;
  travelTicks: number;
  travelCost: number;
} | null {
  if (maintenanceTravelBlockReason(ship)) return null;
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  if (!ft || !fuel) return null;

  const reachable = reachableNeighbors(world, ship.location).find(n => n.to === dst);
  if (!reachable) return null;

  const perDist = effectivePerDistance(ship, ft.perDistance);
  const fuelNeeded = reachable.dist * perDist;
  if (fuelNeeded > fuel.qty) return null;

  const dstMarket = world.markets[dst];
  const fuelAfter = fuel.qty - fuelNeeded;
  const dstHasMyFuel = ship.fuelTypes.some(
    f => (dstMarket.stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4,
  );
  const safeReserve = fuelAfter >= ship.fuelCapacity * FUEL_POST_TRADE_MIN;
  if (!dstHasMyFuel && !safeReserve) return null;

  const hereMarket = world.markets[ship.location];
  const fuelPrice = hereMarket.prices[fuel.good] ?? 0;
  const travelTicks = Math.max(1, Math.ceil(reachable.dist / ship.speed));
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

function destinationLoadoutPlanCandidates(world: World, ship: Trader, drawFraction: number): Candidate[] {
  if (maintenanceTravelBlockReason(ship)) return [];
  const hereMarket = world.markets[ship.location];
  const usedMass = ship.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
  const freeMassBase = Math.max(0, ship.capacity - usedMass);

  const visibleRescues = listAvailableRescueJobs(world);
  const loadedCargo = cargoByGood(ship);
  const out: Candidate[] = [];

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
      .filter(j =>
        j.destination === dstId
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
    const planText = steps.join(" → ");
    const finalCargoMass = Math.min(ship.capacity, usedMass + cargoMassFor(buys, world));
    const cargoText = buys.length > 1
      ? ` Highlighted buys share the same cargo bay; planned cargo mass ${Math.round(finalCargoMass)}/${ship.capacity}.`
      : "";
    const reason = `${planText.charAt(0).toUpperCase()}${planText.slice(1)}. Estimated net Ç${Math.round(expectedNet).toLocaleString()} over ${profile.travelTicks + 1} ticks.${cargoText}`;
    out.push({
      value: expectedNet,
      hint: {
        kind: "route_plan",
        dst: dstId,
        buys,
        acceptJobIds,
        expectedNet,
        ticks: profile.travelTicks + 1,
        reason,
        loaded,
      },
    });
  }

  return out;
}

function localJobPlanCandidates(world: World, ship: Trader): Candidate[] {
  const openJobs = listLocalJobs(world, ship.location);
  const acceptedJobs = Object.values(world.jobs).filter(j =>
    j.acceptedBy === ship.id
    && j.destination === ship.location
  );
  const jobs = [...acceptedJobs, ...openJobs];
  if (jobs.length === 0) return [];
  const out: Candidate[] = [];
  const hereMarket = world.markets[ship.location];

  const deliverable = jobs
    .map(job => ({
      job,
      onHand: ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0),
    }))
    .filter(x => x.onHand > 0)
    .sort((a, b) => JOB_TIER_PRIORITY[a.job.tier] - JOB_TIER_PRIORITY[b.job.tier] || a.job.expiresAt - b.job.expiresAt);

  if (deliverable.length > 0) {
    const acceptJobIds = deliverable.filter(x => x.job.acceptedBy == null).map(x => x.job.id);
    const sells = new Map<GoodId, number>();
    let value = 0;
    for (const { job, onHand } of deliverable) {
      const lots = ship.cargo.filter(l => l.good === job.good);
      const totalCost = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      const sellQty = Math.min(onHand, job.qty);
      const sellNet = (hereMarket.prices[job.good] ?? 0) * (1 - SALES_TAX_RATE);
      const bonus = Math.min(onHand, job.qty) * contractUnitValue(job, ship);
      value += sellQty * sellNet - Math.min(totalCost, sellQty * (totalCost / Math.max(1, onHand))) + bonus;
      sells.set(job.good, Math.max(sells.get(job.good) ?? 0, sellQty));
    }
    if (value > 0) {
      const sellList = [...sells].map(([good, qty]) => ({ good, qty }));
      out.push({
        value,
        hint: {
          kind: "job_plan",
          acceptJobIds,
          sells: sellList,
          expectedNet: value,
          ticks: 1,
          reason: acceptJobIds.length > 0
            ? `Accept ${acceptJobIds.length} local contract${acceptJobIds.length === 1 ? "" : "s"} and sell the matching cargo here. Expected value Ç${Math.round(value).toLocaleString()}.`
            : `Sell the matching cargo here to complete active local contract${deliverable.length === 1 ? "" : "s"}. Expected value Ç${Math.round(value).toLocaleString()}.`,
        },
      });
    }
  }

  const fetchable = jobs
    .filter(job => ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0) <= 0)
    .sort((a, b) => JOB_TIER_PRIORITY[a.tier] - JOB_TIER_PRIORITY[b.tier] || a.expiresAt - b.expiresAt);
  if (fetchable.length === 0) return out;

  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  if (!ft || !fuel || maintenanceTravelBlockReason(ship)) return out;

  const perDist = effectivePerDistance(ship, ft.perDistance);
  const fuelPriceHere = hereMarket.prices[fuel.good] ?? 0;
  for (const { to: srcId, dist } of reachableNeighbors(world, ship.location)) {
    const outFuelNeeded = dist * perDist;
    if (outFuelNeeded > fuel.qty) continue;
    const returnFuelNeeded = outFuelNeeded;
    const fuelRemainingAtSource = fuel.qty - outFuelNeeded;
    const fuelDeficitForReturn = Math.max(0, returnFuelNeeded - fuelRemainingAtSource);
    const srcMarket = world.markets[srcId];
    const srcFuelStock = srcMarket.stock[fuel.good] ?? 0;
    const fuelPriceSrc = srcMarket.prices[fuel.good] ?? fuelPriceHere;
    if (fuelDeficitForReturn > 0.001 && srcFuelStock < fuelDeficitForReturn) continue;

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
      const stockReservedForReturnFuel = job.good === fuel.good ? fuelDeficitForReturn : 0;
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
    const oneWayTicks = Math.max(1, Math.ceil(dist / ship.speed));
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
      hint: {
        kind: "route_plan",
        dst: srcId,
        buys: [],
        futureBuys,
        acceptJobIds,
        expectedNet,
        ticks: oneWayTicks * 2 + 1,
        reason: `${acceptJobIds.length > 0 ? `Accept ${acceptJobIds.length} remaining local contract${acceptJobIds.length === 1 ? "" : "s"} → ` : ""}${acceptedLocalCount > 0 ? `keep ${acceptedLocalCount} active local contract${acceptedLocalCount === 1 ? "" : "s"} in plan → ` : ""}fly to ${srcName} → buy ${plannedBuyList(futureBuys, world)} → return and deliver. Estimated net Ç${Math.round(expectedNet).toLocaleString()} over ${oneWayTicks * 2 + 1} ticks.`,
      },
    });
  }

  return out;
}

// Returns candidates for accepting unaccepted local shortage jobs. Two cases:
//   A) Player already has the good in cargo → accepting is a costless click
//      that adds the reward to the next sell-here. value = sellPnL + bonus
//      so accept_job edges out a plain sell_here whenever the bonus is real.
//   B) Cargo is empty → estimate the cheapest round-trip fetch from a
//      reachable neighbor and use that as the accept_job's value.
function localJobAcceptCandidates(world: World, ship: Trader): { value: number; hint: GuidedHint }[] {
  const out: { value: number; hint: GuidedHint }[] = [];
  const jobs = listLocalJobs(world, ship.location);
  if (jobs.length === 0) return out;
  const hereMarket = world.markets[ship.location];
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  const travelBlocked = maintenanceTravelBlockReason(ship);

  for (const job of jobs) {
    const onHand = ship.cargo
      .filter(l => l.good === job.good)
      .reduce((s, l) => s + l.qty, 0);
    const perUnitReward = job.reward / job.qty;

    if (onHand > 0) {
      // Case A — already carrying. Compute what the next sell-here would
      // realize, then add the contract bonus on the creditable portion.
      const lots = ship.cargo.filter(l => l.good === job.good);
      const totalCost = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      const hereGross = hereMarket.prices[job.good] ?? 0;
      const hereNet = hereGross * (1 - SALES_TAX_RATE);
      const sellPnL = (onHand * hereNet) - totalCost;
      const credit = Math.min(onHand, job.qty);
      const bonus = credit * perUnitReward;
      const value = sellPnL + bonus;
      const goodName = world.goods[job.good]?.name ?? job.good;
      out.push({
        value,
        hint: {
          kind: "accept_job",
          jobId: job.id,
          reason: onHand >= job.qty
            ? `You're carrying ${onHand.toFixed(0)} ${goodName} — accept and sell here to lock in a Ç${Math.round(bonus).toLocaleString()} contract bonus on top of Ç${Math.round(sellPnL).toLocaleString()} sell P&L.`
            : `You're carrying ${onHand.toFixed(0)} ${goodName} (contract wants ${job.qty}) — accept and sell here for partial credit: Ç${Math.round(bonus).toLocaleString()} bonus.`,
          expectedNet: value,
          ticks: 1,
        },
      });
      continue;
    }

    // Case B — empty bay. Find the cheapest fetch from a reachable neighbor.
    if (!ft || !fuel || travelBlocked) continue;
    const goodWeight = world.goods[job.good]?.weight ?? 1;
    const fuelPriceHere = hereMarket.prices[fuel.good] ?? 0;
    const dstGross = hereMarket.prices[job.good] ?? 0;
    const dstNet = dstGross * (1 - SALES_TAX_RATE);
    let best: { srcId: LocationId; net: number; ticks: number; qty: number; srcPrice: number } | null = null;

    const perDist = effectivePerDistance(ship, ft.perDistance);
    for (const { to: srcId, dist } of reachableNeighbors(world, ship.location)) {
      const outFuelNeeded = dist * perDist;
      if (outFuelNeeded > fuel.qty) continue;            // can't even get there
      const srcMarket = world.markets[srcId];
      const srcStock = srcMarket.stock[job.good] ?? 0;
      if (srcStock < 1) continue;
      const srcPrice = srcMarket.prices[job.good] ?? 0;

      const fuelRemainingAtSource = fuel.qty - outFuelNeeded;
      const returnFuelNeeded = outFuelNeeded;
      const fuelDeficitForReturn = Math.max(0, returnFuelNeeded - fuelRemainingAtSource);
      const srcFuelStock = srcMarket.stock[fuel.good] ?? 0;
      const fuelPriceSrc = srcMarket.prices[fuel.good] ?? fuelPriceHere;
      if (fuelDeficitForReturn > 0.001 && srcFuelStock < fuelDeficitForReturn) continue;

      const stockReservedForReturnFuel = job.good === fuel.good ? fuelDeficitForReturn : 0;
      const stockAvailableForCargo = Math.max(0, srcStock - stockReservedForReturnFuel);
      const returnFuelCash = fuelDeficitForReturn * fuelPriceSrc;

      const maxByCargo = Math.floor(ship.capacity / goodWeight);
      const maxByFunds = srcPrice > 0 ? Math.floor((ship.funds - returnFuelCash) / srcPrice) : 0;
      const buyQty = Math.max(0, Math.min(maxByCargo, maxByFunds, Math.floor(stockAvailableForCargo), job.qty));
      if (buyQty < 1) continue;

      const oneWayTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const totalTicks = oneWayTicks * 2 + 1;            // out, return, accept/sell tick
      const outFuelCost = outFuelNeeded * fuelPriceHere;
      const existingFuelForReturn = Math.min(returnFuelNeeded, Math.max(0, fuelRemainingAtSource));
      const returnFuelCost = existingFuelForReturn * fuelPriceHere + returnFuelCash;
      const tripMaint = oneWayTicks * 2 * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFees = ship.capacity * DOCKING_FEE_PER_CAPACITY * 2;

      const buyCost = buyQty * srcPrice;
      const sellRevenue = buyQty * dstNet;
      const credit = Math.min(buyQty, job.qty);
      const jobBonus = credit * perUnitReward;
      const net = sellRevenue + jobBonus - buyCost - outFuelCost - returnFuelCost - tripMaint - dockingFees;

      if (!best || net > best.net) best = { srcId, net, ticks: totalTicks, qty: buyQty, srcPrice };
    }

    if (best && best.net > 0) {
      const srcName = world.locations[best.srcId]?.name ?? best.srcId;
      const goodName = world.goods[job.good]?.name ?? job.good;
      out.push({
        value: best.net,
        hint: {
          kind: "accept_job",
          jobId: job.id,
          reason: `Accept → fly to ${srcName} → buy ${best.qty} ${goodName} @ Ç${best.srcPrice.toFixed(1)} → return → deliver. Estimated net Ç${Math.round(best.net).toLocaleString()} over ${best.ticks} ticks (incl. Ç${job.reward.toLocaleString()} reward).`,
          expectedNet: best.net,
          ticks: best.ticks,
        },
      });
    }
  }

  // Remote-Case-A: for any unaccepted shortage contract elsewhere, if we're
  // carrying the requested good and can reach the destination, suggest
  // accepting + flying out to deliver. Naturally rewards "speculative buy
  // here, hold for a contract" play.
  if (ft && fuel && !travelBlocked) {
    const here = ship.location;
    for (const job of Object.values(world.jobs)) {
      if (job.acceptedBy != null) continue;
      if (job.kind !== "shortage") continue;
      if (job.destination === here) continue;            // local — already handled above
      const onHand = ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0);
      if (onHand <= 0) continue;
      const profile = travelProfile(world, ship, job.destination);
      if (!profile) continue;
      const dstMarket = world.markets[job.destination];
      const dstPrice = dstMarket.prices[job.good] ?? 0;
      const sellNet = onHand * dstPrice * (1 - SALES_TAX_RATE);
      const lots = ship.cargo.filter(l => l.good === job.good);
      const totalCost = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      const credit = Math.min(onHand, job.qty);
      const bonus = credit * (job.reward / job.qty);
      const value = sellNet + bonus - totalCost - profile.travelCost;
      if (value <= 0) continue;
      const dstName = world.locations[job.destination]?.name ?? job.destination;
      const goodName = world.goods[job.good]?.name ?? job.good;
      out.push({
        value,
        hint: {
          kind: "accept_job",
          jobId: job.id,
          reason: `Accept and head to ${dstName} — your ${onHand.toFixed(0)} ${goodName} delivers a Ç${Math.round(bonus).toLocaleString()} contract bonus on top of Ç${Math.round(sellNet - totalCost).toLocaleString()} sell P&L.`,
          expectedNet: value,
          ticks: profile.travelTicks + 1,
        },
      });
    }
  }

  return out;
}

// Returns scored candidates for actions involving the loaded cargo (sell here
// or travel-to-sell). One entry per (good × destination), aggregated across
// per-good lots since selling N units of good X uses FIFO across all lots.
// The "value" is realized P&L (revenue - cost basis) so it compares apples-
// to-apples with buy_for_route's totalProfit.
function cargoLoadedCandidates(world: World, ship: Trader): { value: number; hint: GuidedHint }[] {
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  const out: { value: number; hint: GuidedHint }[] = [];
  const travelBlocked = maintenanceTravelBlockReason(ship);

  // Pre-index unaccepted shortage contracts by (destination|good) → bonus.
  // The suggestion engine assumes the player will accept on arrival (or has
  // a navigator), so any matching destination earns the bonus when scoring.
  const unacceptedBonus = new Map<string, { perUnit: number; remaining: number; jobId: string }>();
  if (canRealizeUnacceptedContracts(world, ship)) {
    for (const j of Object.values(world.jobs)) {
      if (j.acceptedBy != null || j.kind !== "shortage") continue;
      unacceptedBonus.set(`${j.destination}|${j.good}`, {
        perUnit: j.reward / j.qty,
        remaining: j.qty,
        jobId: j.id,
      });
    }
  }

  // Aggregate per-good across lots
  const byGood = new Map<string, { totalQty: number; totalCost: number }>();
  for (const lot of ship.cargo) {
    const g = byGood.get(lot.good) ?? { totalQty: 0, totalCost: 0 };
    g.totalQty += lot.qty;
    g.totalCost += lot.qty * lot.unitPrice;
    byGood.set(lot.good, g);
  }

  for (const [goodId, agg] of byGood) {
    const good = world.goods[goodId];
    if (!good) continue;
    const hereGross = marketQuote(world, ship.location, goodId);
    const hereNet = hereGross * (1 - SALES_TAX_RATE);
    const hereRevenue = agg.totalQty * hereNet;
    const sellHerePnL = hereRevenue - agg.totalCost;

    out.push({
      value: sellHerePnL,
      hint: { kind: "sell_here", good: goodId, qty: agg.totalQty, revenue: hereRevenue },
    });

    if (!ft || !fuel || travelBlocked) continue;
    const perDist = effectivePerDistance(ship, ft.perDistance);

    for (const { to, dist } of reachableNeighbors(world, ship.location)) {
      const fuelNeeded = dist * perDist;
      if (fuelNeeded > fuel.qty) continue;
      const dstMarket = world.markets[to];
      const dstLoc = world.locations[to];
      const dstTarget = dstLoc.targetStock[goodId] ?? 0;
      const dstStockNow = dstMarket.stock[goodId] ?? 0;
      const dstGross = good.category !== "upgrade" && dstTarget > 0
        ? priceFor(good.basePrice, dstStockNow, dstTarget)
        : marketQuote(world, to, goodId);
      const dstNet = dstGross * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * marketQuote(world, ship.location, fuel.good);
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
      let netRevenue = agg.totalQty * dstNet - fuelCost - tripMaint - dockingFee;
      // Fold in unaccepted contract bonus if there's a matching shortage at
      // this destination — encourages "hold for contract" behavior over
      // marginal local sells.
      const bonus = unacceptedBonus.get(`${to}|${goodId}`);
      let jobId: string | undefined;
      let jobAccepted: boolean | undefined;
      if (bonus) {
        const credited = Math.min(agg.totalQty, bonus.remaining);
        netRevenue += credited * bonus.perUnit;
        jobId = bonus.jobId;
        jobAccepted = false;
      }
      const travelPnL = netRevenue - agg.totalCost;
      out.push({
        value: travelPnL,
        hint: {
          kind: "travel_to_sell",
          dst: to,
          good: goodId,
          qty: agg.totalQty,
          expectedNet: netRevenue,
          gainOverHere: netRevenue - hereRevenue,
          ticks: travelTicks,
          jobId,
          jobAccepted,
        },
      });
    }
  }

  return out;
}

export function describeHint(hint: GuidedHint, world: World): string {
  const goodName = (id: string) => world.goods[id]?.name ?? id;
  switch (hint.kind) {
    case "buy_for_route": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      const jobNote = hint.jobId
        ? hint.jobAccepted === false
          ? " — includes a contract bonus you can accept on arrival"
          : " — fulfills an active contract"
        : "";
      return `Buy ${hint.qty} ${goodName(hint.good)} here → travel to ${dst} → sell. Net Ç${Math.round(hint.netProfit).toLocaleString()} over ${hint.ticks} ticks (Ç${hint.profitPerTick.toFixed(1)}/t)${jobNote}.`;
    }
    case "travel_to_sell": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      if (hint.jobId) {
        const contractStep = hint.jobAccepted === false ? "accept the matching contract and deliver" : "deliver";
        return `Travel to ${dst} to ${contractStep} your ${hint.qty.toFixed(0)} ${goodName(hint.good)} — expected net Ç${Math.round(hint.expectedNet).toLocaleString()}.`;
      }
      return `Travel to ${dst} to sell your ${hint.qty.toFixed(0)} ${goodName(hint.good)} — expected net Ç${Math.round(hint.expectedNet).toLocaleString()} (Ç${Math.round(hint.gainOverHere).toLocaleString()} better than selling here).`;
    }
    case "sell_here": {
      const jobNote = hint.jobId ? " (fulfills a contract)" : "";
      return `Sell your ${hint.qty.toFixed(0)} ${goodName(hint.good)} here for Ç${Math.round(hint.revenue).toLocaleString()} net${jobNote}. No better destination is reachable.`;
    }
    case "refuel":
      return hint.critical ? `⚠ ${hint.reason}` : hint.reason;
    case "speculate": {
      const via = world.locations[hint.via]?.name ?? hint.via;
      const dst = world.locations[hint.thenSellAt]?.name ?? hint.thenSellAt;
      return `No good trade from here. Reposition to ${via} (empty) → buy ${goodName(hint.thenBuy)} → sell at ${dst}. Net Ç${Math.round(hint.netProfit).toLocaleString()} over ${hint.ticks} ticks after positioning costs.`;
    }
    case "accept_job":
      return hint.reason;
    case "route_plan":
      return hint.reason;
    case "job_plan":
      return hint.reason;
    case "wait":
      return hint.reason;
  }
}

// markers used by the UI to highlight elements
export interface HintTarget {
  buyGood?: GoodId;
  buyQty?: number;             // engine's recommended buy qty — leaves room for contract goods
  buyGoods?: Partial<Record<GoodId, number>>;
  sellGood?: GoodId;
  sellGoods?: GoodId[];
  carryGood?: GoodId;
  carryGoods?: GoodId[];
  travelTo?: LocationId;
  travelLabel?: string;
  refuel?: boolean;
  critical?: boolean;
  acceptJobId?: JobId;
  acceptJobIds?: JobId[];
}

export function hintTarget(hint: GuidedHint): HintTarget {
  switch (hint.kind) {
    case "buy_for_route":
      return { buyGood: hint.good, buyQty: hint.qty };
    case "travel_to_sell":
      return { travelTo: hint.dst, travelLabel: hint.jobId ? "Contract delivery" : undefined, carryGood: hint.good };
    case "sell_here":
      return { sellGood: hint.good };
    case "refuel":
      return { refuel: true, critical: hint.critical };
    case "speculate":
      return { travelTo: hint.via };
    case "accept_job":
      return { acceptJobId: hint.jobId };
    case "route_plan": {
      const buyGoods: Partial<Record<GoodId, number>> = {};
      for (const buy of hint.buys) buyGoods[buy.good] = (buyGoods[buy.good] ?? 0) + buy.qty;
      const travelLabel = hint.futureBuys && hint.futureBuys.length > 0
        ? "Contract pickup"
        : hint.buys.some(b => b.reason === "contract")
          ? "Contract run"
          : undefined;
      return { buyGoods, travelTo: hint.dst, travelLabel, acceptJobIds: hint.acceptJobIds };
    }
    case "job_plan":
      return { acceptJobIds: hint.acceptJobIds, sellGoods: hint.sells.map(s => s.good) };
    case "wait":
      return {};
  }
}
