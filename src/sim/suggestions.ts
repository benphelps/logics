import type { GoodId, Job, JobId, LocationId, Trader, World } from "./types";
import { reachableNeighbors, routeDistance } from "./geometry";
import { marketQuote, priceFor } from "./pricing";
import { activeFuelType, listSpeculativeOptions, listTradeOptions, maintenanceTravelBlockReason, refuelManual, selectRefuelType, sellAtLocation, type TradeOption } from "./traders";
import { acceptJob, collectTradeJob, listLocalJobs } from "./jobs";
import { effectivePerDistance, hasCrew, ignoresFuel, travelTicksFor } from "./crew";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";
import {
  buildDestinationLoadoutPlans,
  buildLocalFetchPlans,
  type PlannedBuy,
  type PlannedSell,
  type RoutePlanCandidate,
} from "./loadoutPlans";

export type { PlannedBuy, PlannedSell } from "./loadoutPlans";

export type GuidedHint =
  | { kind: "buy_for_route"; good: GoodId; qty: number; dst: LocationId; netProfit: number; ticks: number; profitPerTick: number; jobId?: JobId; jobAccepted?: boolean }
  | { kind: "travel_to_sell"; dst: LocationId; good: GoodId; qty: number; expectedNet: number; gainOverHere: number; ticks: number; jobId?: JobId; jobAccepted?: boolean }
  | { kind: "sell_here"; good: GoodId; qty: number; revenue: number; jobId?: JobId }
  | { kind: "refuel"; critical: boolean; reason: string }
  | { kind: "speculate"; via: LocationId; thenBuy: GoodId; thenSellAt: LocationId; netProfit: number; ticks: number }
  | { kind: "accept_job"; jobId: JobId; reason: string; expectedNet: number; ticks: number }
  | { kind: "collect_trade_job"; jobId: JobId; reward: number; reason: string }
  | { kind: "travel_to_collect_trade_job"; jobId: JobId; dst: LocationId; reward: number; ticks: number; reason: string }
  | { kind: "route_plan"; dst: LocationId; buys: PlannedBuy[]; acceptJobIds: JobId[]; expectedNet: number; ticks: number; reason: string; futureBuys?: PlannedBuy[]; loaded?: PlannedSell[] }
  | { kind: "job_plan"; acceptJobIds: JobId[]; sells: PlannedSell[]; expectedNet: number; ticks: number; reason: string }
  | { kind: "wait"; reason: string };

const FUEL_LOW_FRACTION = 0.50;          // refuel proactively below this when local fuel exists
const FUEL_CRITICAL_FRACTION = 0.15;     // override anything else below this
const FUEL_POST_TRADE_MIN = 0.30;        // if a trade would leave you below this and you can refuel here, refuel first
const LOCAL_SELL_EXIT_MIN_VALUE = 0.5;
const JOB_TIER_PRIORITY = { high: 0, medium: 1, low: 2 } as const;

type Candidate = { value: number; hint: GuidedHint };
type GuidedHintMode = "advisory" | "actual";
type CargoJob = Job & { good: GoodId };

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

function hasJobGood(job: Job): job is CargoJob {
  return job.kind !== "trade" && job.good != null;
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

function acceptedTradeJobsForShip(world: World, ship: Trader): Job[] {
  return Object.values(world.jobs)
    .filter(j => j.kind === "trade" && j.acceptedBy === ship.id)
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

function tradeSettlementHint(world: World, ship: Trader, canRefuelHere: boolean): GuidedHint | null {
  const jobs = acceptedTradeJobsForShip(world, ship);
  const job = jobs.find(j => j.destination === ship.location) ?? jobs[0];
  if (!job) return null;
  const stationName = world.locations[job.destination]?.name ?? job.destination;
  const ticker = job.trade?.ticker ?? "trade";
  const reward = job.reward;
  if (ship.location === job.destination) {
    return {
      kind: "collect_trade_job",
      jobId: job.id,
      reward,
      reason: `Collect ${ticker} exchange settlement at ${stationName} for Ç${reward.toLocaleString()}.`,
    };
  }

  const blocked = maintenanceTravelBlockReason(ship);
  if (blocked) return { kind: "wait", reason: blocked };

  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
  const fuel = ship.currentFuel;
  if ((!ft || !fuel) && !fuelFree) {
    return { kind: "wait", reason: `Exchange settlement waiting at ${stationName}, but this ship has no compatible fuel loaded.` };
  }

  const hop = nextHopToward(world, ship.location, job.destination);
  if (!hop) return { kind: "wait", reason: `No plotted route to ${stationName} for the pending exchange settlement.` };
  const fuelNeeded = hop.dist * (fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance));
  if (!fuelFree && fuelNeeded > fuel!.qty + 0.001) {
    if (canRefuelHere) return { kind: "refuel", critical: true, reason: `Refuel to reach the pending ${ticker} settlement at ${stationName}.` };
    return { kind: "wait", reason: `Pending ${ticker} settlement at ${stationName}, but fuel is too low for the next hop.` };
  }
  const hopName = world.locations[hop.to]?.name ?? hop.to;
  const ticks = travelTicksFor(ship, hop.dist);
  return {
    kind: "travel_to_collect_trade_job",
    jobId: job.id,
    dst: hop.to,
    reward,
    ticks,
    reason: hop.to === job.destination
      ? `Travel to ${stationName} and collect the ${ticker} exchange settlement for Ç${reward.toLocaleString()}.`
      : `Travel toward ${stationName} via ${hopName} to collect the ${ticker} exchange settlement for Ç${reward.toLocaleString()}.`,
  };
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

  const settlementHint = tradeSettlementHint(world, advisoryShip, canRefuelHere);
  if (settlementHint) return settlementHint;

  // Critical fuel + fuel for sale here → refuel right now (override everything)
  if (!ignoresFuel(advisoryShip) && fuel && ft) {
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
    ? Object.values(world.jobs).filter((j): j is CargoJob => hasJobGood(j) && j.acceptedBy === advisoryShip.id)
    : [];
  const jobByKey = new Map<string, typeof acceptedJobs[number]>();
  for (const j of acceptedJobs) jobByKey.set(`${j.destination}|${j.good}`, j);

  const candidates: Candidate[] = [];

  if (options.mode === "actual" && advisoryShip.pilot === "auto") {
    const loadoutPlans = hasCrew(advisoryShip, "captain")
      ? [
        ...buildDestinationLoadoutPlans(world, advisoryShip, drawFraction ?? 1),
        ...buildLocalFetchPlans(world, advisoryShip),
      ].sort((a, b) =>
        b.value - a.value
        || b.buys.length - a.buys.length
        || a.dst.localeCompare(b.dst),
      )
      : [];
    const loadoutPlan = loadoutPlans[0];
    if (loadoutPlan && (!buyOptions[0] || loadoutPlan.value >= buyOptions[0].totalProfit)) {
      return routePlanCandidate(loadoutPlan).hint;
    }
    if (buyOptions[0]) return buyHintFromTradeOption(buyOptions[0]);
    if (advisoryShip.cargo.length === 0) {
      const sp = listSpeculativeOptions(world, advisoryShip, drawFraction)[0];
      if (sp) {
        return { kind: "speculate", via: sp.via, thenBuy: sp.thenBuy, thenSellAt: sp.thenSellAt, netProfit: sp.netProfit, ticks: sp.totalTicks };
      }
    }
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
    candidates.push(...buildDestinationLoadoutPlans(world, advisoryShip, drawFraction ?? 1).map(routePlanCandidate));
    candidates.push(...buildLocalFetchPlans(world, advisoryShip).map(routePlanCandidate));
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
    || hint.kind === "collect_trade_job"
    || hint.kind === "job_plan"
    || hint.kind === "accept_job"
    || hint.kind === "refuel";
}

function planHintKey(hint: GuidedHint): string {
  switch (hint.kind) {
    case "sell_here": return `${hint.kind}|${hint.good}|${Math.round(hint.qty)}`;
    case "job_plan": return `${hint.kind}|${hint.acceptJobIds.join(",")}|${hint.sells.map(s => `${s.good}:${Math.round(s.qty)}`).join(",")}`;
    case "accept_job": return `${hint.kind}|${hint.jobId}`;
    case "collect_trade_job": return `${hint.kind}|${hint.jobId}`;
    case "travel_to_collect_trade_job": return `${hint.kind}|${hint.jobId}|${hint.dst}`;
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
    case "collect_trade_job":
      return collectTradeJob(world, hint.jobId, ship.id).ok;
    case "refuel":
      return refuelManual(world, ship).ok;
    default:
      return false;
  }
}

function routePlanCandidate(plan: RoutePlanCandidate): Candidate {
  return {
    value: plan.value,
    hint: {
      kind: "route_plan",
      dst: plan.dst,
      buys: plan.buys,
      acceptJobIds: plan.acceptJobIds,
      expectedNet: plan.expectedNet,
      ticks: plan.ticks,
      reason: plan.reason,
      futureBuys: plan.futureBuys,
      loaded: plan.loaded,
    },
  };
}

function contractUnitValue(job: Job, ship: Trader): number {
  return (job.reward + (job.acceptedBy === ship.id ? job.penalty : 0)) / job.qty;
}

function travelFuelIntent(world: World, ship: Trader, hint: GuidedHint, buyOptions: TradeOption[]): TravelFuelIntent | null {
  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
  const fuel = ship.currentFuel;
  if ((!ft || !fuel) && !fuelFree) return null;

  let dst: LocationId | null = null;
  let plannedFuelNeeded: number | null = null;
  if (hint.kind === "buy_for_route") {
    dst = hint.dst;
    plannedFuelNeeded = buyOptions.find(o => o.good === hint.good && o.to === hint.dst)?.fuelNeeded ?? null;
  } else if (hint.kind === "travel_to_sell") {
    dst = hint.dst;
  } else if (hint.kind === "travel_to_collect_trade_job") {
    dst = hint.dst;
  } else if (hint.kind === "route_plan") {
    dst = hint.dst;
  } else if (hint.kind === "speculate") {
    dst = hint.via;
  }
  if (!dst) return null;

  const directDist = routeDistance(world, ship.location, dst);
  if (directDist == null && plannedFuelNeeded == null) return null;
  const fuelNeeded = plannedFuelNeeded ?? directDist! * (fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance));
  const fuelAfter = fuelFree ? ship.fuelCapacity : fuel!.qty - fuelNeeded;
  const dstHasFuel = fuelFree || ship.fuelTypes.some(f => (world.markets[dst].stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4);
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

function localJobPlanCandidates(world: World, ship: Trader): Candidate[] {
  const openJobs = listLocalJobs(world, ship.location).filter(hasJobGood);
  const acceptedJobs = Object.values(world.jobs).filter((j): j is CargoJob =>
    hasJobGood(j)
    && j.acceptedBy === ship.id
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
  const jobs = listLocalJobs(world, ship.location).filter(hasJobGood);
  if (jobs.length === 0) return out;
  const hereMarket = world.markets[ship.location];
  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
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
    if (((!ft || !fuel) && !fuelFree) || travelBlocked) continue;
    const goodWeight = world.goods[job.good]?.weight ?? 1;
    const fuelGood = fuel?.good ?? ft?.good;
    const fuelPriceHere = fuelGood ? hereMarket.prices[fuelGood] ?? 0 : 0;
    const dstGross = hereMarket.prices[job.good] ?? 0;
    const dstNet = dstGross * (1 - SALES_TAX_RATE);
    let best: { srcId: LocationId; net: number; ticks: number; qty: number; srcPrice: number } | null = null;

    const perDist = fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance);
    for (const { to: srcId, dist } of reachableNeighbors(world, ship.location)) {
      const outFuelNeeded = dist * perDist;
      if (!fuelFree && outFuelNeeded > fuel!.qty) continue;            // can't even get there
      const srcMarket = world.markets[srcId];
      const srcStock = srcMarket.stock[job.good] ?? 0;
      if (srcStock < 1) continue;
      const srcPrice = srcMarket.prices[job.good] ?? 0;

      const fuelRemainingAtSource = fuelFree ? ship.fuelCapacity : fuel!.qty - outFuelNeeded;
      const returnFuelNeeded = outFuelNeeded;
      const fuelDeficitForReturn = Math.max(0, returnFuelNeeded - fuelRemainingAtSource);
      const srcFuelStock = fuelGood ? srcMarket.stock[fuelGood] ?? 0 : 0;
      const fuelPriceSrc = fuelGood ? srcMarket.prices[fuelGood] ?? fuelPriceHere : 0;
      if (!fuelFree && fuelDeficitForReturn > 0.001 && srcFuelStock < fuelDeficitForReturn) continue;

      const stockReservedForReturnFuel = !fuelFree && job.good === fuelGood ? fuelDeficitForReturn : 0;
      const stockAvailableForCargo = Math.max(0, srcStock - stockReservedForReturnFuel);
      const returnFuelCash = fuelDeficitForReturn * fuelPriceSrc;

      const maxByCargo = Math.floor(ship.capacity / goodWeight);
      const maxByFunds = srcPrice > 0 ? Math.floor((ship.funds - returnFuelCash) / srcPrice) : 0;
      const buyQty = Math.max(0, Math.min(maxByCargo, maxByFunds, Math.floor(stockAvailableForCargo), job.qty));
      if (buyQty < 1) continue;

      const oneWayTicks = travelTicksFor(ship, dist);
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
  if ((fuelFree || (ft && fuel)) && !travelBlocked) {
    const here = ship.location;
    for (const job of Object.values(world.jobs)) {
      if (job.acceptedBy != null) continue;
      if (job.kind !== "shortage") continue;
      if (!job.good) continue;
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
  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
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
      if (!j.good) continue;
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

    if (((!ft || !fuel) && !fuelFree) || travelBlocked) continue;
    const perDist = fuelFree ? 0 : effectivePerDistance(ship, ft!.perDistance);

    for (const { to, dist } of reachableNeighbors(world, ship.location)) {
      const fuelNeeded = dist * perDist;
      if (!fuelFree && fuelNeeded > fuel!.qty) continue;
      const dstMarket = world.markets[to];
      const dstLoc = world.locations[to];
      const dstTarget = dstLoc.targetStock[goodId] ?? 0;
      const dstStockNow = dstMarket.stock[goodId] ?? 0;
      const dstGross = good.category !== "upgrade" && dstTarget > 0
        ? priceFor(good.basePrice, dstStockNow, dstTarget)
        : marketQuote(world, to, goodId);
      const dstNet = dstGross * (1 - SALES_TAX_RATE);
      const fuelGood = fuel?.good ?? ft?.good;
      const fuelCost = fuelGood ? fuelNeeded * marketQuote(world, ship.location, fuelGood) : 0;
      const travelTicks = travelTicksFor(ship, dist);
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
    case "collect_trade_job":
      return hint.reason;
    case "travel_to_collect_trade_job":
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
  collectJobId?: JobId;
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
    case "collect_trade_job":
      return { collectJobId: hint.jobId };
    case "travel_to_collect_trade_job":
      return { travelTo: hint.dst, travelLabel: "Trade settlement" };
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
