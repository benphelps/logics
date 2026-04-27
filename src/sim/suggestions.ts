import type { GoodId, JobId, LocationId, Trader, World } from "./types";
import { distance, reachableNeighbors } from "./geometry";
import { priceFor } from "./pricing";
import { activeFuelType, listSpeculativeOptions, listTradeOptions, maintenanceTravelBlockReason, selectRefuelType } from "./traders";
import { listLocalJobs } from "./jobs";
import { effectivePerDistance, hasCrew } from "./crew";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";

export type GuidedHint =
  | { kind: "buy_for_route"; good: GoodId; qty: number; dst: LocationId; netProfit: number; ticks: number; profitPerTick: number; jobId?: JobId; jobAccepted?: boolean }
  | { kind: "travel_to_sell"; dst: LocationId; good: GoodId; qty: number; expectedNet: number; gainOverHere: number; ticks: number; jobId?: JobId }
  | { kind: "sell_here"; good: GoodId; qty: number; revenue: number; jobId?: JobId }
  | { kind: "refuel"; critical: boolean; reason: string }
  | { kind: "speculate"; via: LocationId; thenBuy: GoodId; thenSellAt: LocationId; netProfit: number; ticks: number }
  | { kind: "accept_job"; jobId: JobId; reason: string; expectedNet: number; ticks: number }
  | { kind: "wait"; reason: string };

const FUEL_LOW_FRACTION = 0.50;          // refuel proactively below this when local fuel exists
const FUEL_CRITICAL_FRACTION = 0.15;     // override anything else below this
const FUEL_POST_TRADE_MIN = 0.30;        // if a trade would leave you below this and you can refuel here, refuel first

function isPlayerShip(world: World, ship: Trader): boolean {
  return world.player?.shipIds.includes(ship.id) ?? false;
}

function canRealizeUnacceptedContracts(world: World, ship: Trader): boolean {
  return isPlayerShip(world, ship)
    && (ship.pilot === "manual" || (ship.pilot === "auto" && hasCrew(ship, "navigator")));
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

export function getGuidedHint(world: World, ship: Trader): GuidedHint {
  if (ship.state === "transit") {
    return { kind: "wait", reason: `In transit to ${world.locations[ship.destination!]?.name ?? ship.destination}.` };
  }

  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  const canRefuelHere = canAffordRefuelHere(world, ship);
  const travelBlocked = maintenanceTravelBlockReason(ship);

  // Critical fuel + fuel for sale here → refuel right now (override everything)
  if (fuel && ft) {
    const fraction = fuel.qty / ship.fuelCapacity;

    if (!travelBlocked && fraction < FUEL_CRITICAL_FRACTION && canRefuelHere) {
      return { kind: "refuel", critical: true, reason: `Tank at ${(fraction * 100).toFixed(0)}% — refuel before any move.` };
    }
  }

  // Consider both buy-here-and-travel options AND (if cargo is loaded) sell
  // and travel-to-sell options. Pick the single highest-value action across
  // all of them. This makes the engine "hedging-aware" — when the player has
  // partial cargo, the engine can suggest topping off with a different good
  // if that's the best move, instead of being stuck on the existing cargo.

  // Player isn't subject to MAX_DRAW_FRACTION (NPC fairness rule).
  const drawFraction = ship.pilot === "manual" ? 1.0 : undefined;
  const buyOptions = listTradeOptions(world, ship, undefined, drawFraction);
  const cargoSell = ship.cargo.length > 0 ? cargoLoadedCandidates(world, ship) : [];

  // Pre-index the player's accepted jobs by (destination|good) for quick
  // lookup when scoring trade candidates. Jobs reward routes they target.
  const acceptedJobs = ship.pilot === "manual"
    ? Object.values(world.jobs).filter(j => j.acceptedBy === ship.id)
    : [];
  const jobByKey = new Map<string, typeof acceptedJobs[number]>();
  for (const j of acceptedJobs) jobByKey.set(`${j.destination}|${j.good}`, j);

  type Candidate = { value: number; hint: GuidedHint };
  const candidates: Candidate[] = [];

  for (const o of buyOptions) {
    // listTradeOptions already folds the contract bonus into totalProfit for
    // accepted jobs — we just tag the hint so the UI can show "fulfills an
    // active contract".
    const job = jobByKey.get(`${o.to}|${o.good}`);
    candidates.push({
      value: o.totalProfit,
      hint: {
        kind: "buy_for_route",
        good: o.good,
        qty: o.qty,
        dst: o.to,
        netProfit: o.totalProfit,
        ticks: o.travelTicks + 1,
        profitPerTick: o.profitPerTick,
        jobId: o.jobId ?? job?.id,
        jobAccepted: o.jobAccepted ?? (job ? true : undefined),
      },
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
      }
    } else if (c.hint.kind === "sell_here") {
      const job = jobByKey.get(`${ship.location}|${c.hint.good}`);
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
  if (ship.pilot === "manual") {
    candidates.push(...localJobAcceptCandidates(world, ship));
  }

  // Speculative travel — only when cargo is empty (otherwise the player has
  // existing cargo to deal with first). Score against direct candidates.
  if (ship.cargo.length === 0) {
    for (const sp of listSpeculativeOptions(world, ship, drawFraction)) {
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
  const top = candidates[0];

  // Pre-emptive refuel: if the player follows the top suggestion blindly and
  // would land critically low at a destination that may not have fuel,
  // suggest refueling FIRST (assuming current location does have fuel).
  // Without this, the engine happily walks the player into a stranding.
  if (fuel && ft && canRefuelHere && !travelBlocked) {
    const fraction = fuel.qty / ship.fuelCapacity;

    // Cargo is empty AND tank below LOW_FRACTION → top off opportunistically
    if (ship.cargo.length === 0 && fraction < FUEL_LOW_FRACTION) {
      return { kind: "refuel", critical: false, reason: `Tank at ${(fraction * 100).toFixed(0)}% — top off before the next route.` };
    }

    // Top suggestion is buy+travel and would leave fuel critically low
    if (top && top.hint.kind === "buy_for_route") {
      const hint = top.hint;
      const planned = buyOptions.find(o => o.good === hint.good && o.to === hint.dst);
      if (planned) {
        const fuelAfter = fuel.qty - planned.fuelNeeded;
        const dstHasFuel = ship.fuelTypes.some(f => (world.markets[planned.to].stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4);
        if (fuelAfter / ship.fuelCapacity < FUEL_POST_TRADE_MIN && !dstHasFuel) {
          return { kind: "refuel", critical: false, reason: `Refuel here first — that trip would leave you with only ${Math.max(0, fuelAfter).toFixed(0)} fuel at a station with no fuel for sale.` };
        }
      }
    }

    // Same check for travel-to-sell
    if (top && top.hint.kind === "travel_to_sell") {
      const dst = top.hint.dst;
      const dstLoc = world.locations[dst];
      if (dstLoc) {
        const here = world.locations[ship.location];
        const dist = Math.hypot(here.position.x - dstLoc.position.x, here.position.y - dstLoc.position.y);
        const fuelNeeded = dist * effectivePerDistance(ship, ft.perDistance);
        const fuelAfter = fuel.qty - fuelNeeded;
        const dstHasFuel = ship.fuelTypes.some(f => (world.markets[dst].stock[f.good] ?? 0) >= ship.fuelCapacity * 0.4);
        if (fuelAfter / ship.fuelCapacity < FUEL_POST_TRADE_MIN && !dstHasFuel) {
          return { kind: "refuel", critical: false, reason: `Refuel here first — that trip would leave you with only ${Math.max(0, fuelAfter).toFixed(0)} fuel at a station with no fuel for sale.` };
        }
      }
    }
  }

  if (top) return top.hint;

  if (travelBlocked) return { kind: "wait", reason: travelBlocked };

  if (fuel && fuel.qty <= 0.001) {
    if (selectRefuelType(world, ship) == null) {
      return { kind: "wait", reason: "Out of fuel and no compatible fuel for sale here. Wait for a trader to bring some, or summon help." };
    }
    return { kind: "wait", reason: "Out of fuel and can't afford compatible fuel here. Sell cargo if you can, or wait for help." };
  }

  // Fallback: no profitable trade and no refuel triggered
  return { kind: "wait", reason: "No profitable trades from here right now. Wait for prices to shift, or move on speculation." };
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
    const fuelPriceHere = hereMarket.prices[fuel.good] ?? 0;
    const perDist = effectivePerDistance(ship, ft.perDistance);
    for (const job of Object.values(world.jobs)) {
      if (job.acceptedBy != null) continue;
      if (job.kind !== "shortage") continue;
      if (job.destination === here) continue;            // local — already handled above
      const onHand = ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0);
      if (onHand <= 0) continue;
      const dist = distance(world, here, job.destination);
      const fuelNeeded = dist * perDist;
      if (fuelNeeded > fuel.qty) continue;
      const dstMarket = world.markets[job.destination];
      const dstPrice = dstMarket.prices[job.good] ?? 0;
      const sellNet = onHand * dstPrice * (1 - SALES_TAX_RATE);
      const lots = ship.cargo.filter(l => l.good === job.good);
      const totalCost = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      const fuelCost = fuelNeeded * fuelPriceHere;
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
      const credit = Math.min(onHand, job.qty);
      const bonus = credit * (job.reward / job.qty);
      const value = sellNet + bonus - totalCost - fuelCost - tripMaint - dockingFee;
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
          ticks: travelTicks + 1,
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
  const hereMarket = world.markets[ship.location];
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
    const hereGross = hereMarket.prices[goodId];
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
      const dstGross = dstTarget > 0
        ? priceFor(good.basePrice, dstStockNow, dstTarget)
        : dstMarket.prices[goodId];
      const dstNet = dstGross * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * (hereMarket.prices[fuel.good] ?? 0);
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
      let netRevenue = agg.totalQty * dstNet - fuelCost - tripMaint - dockingFee;
      // Fold in unaccepted contract bonus if there's a matching shortage at
      // this destination — encourages "hold for contract" behavior over
      // marginal local sells.
      const bonus = unacceptedBonus.get(`${to}|${goodId}`);
      let jobId: string | undefined;
      if (bonus) {
        const credited = Math.min(agg.totalQty, bonus.remaining);
        netRevenue += credited * bonus.perUnit;
        jobId = bonus.jobId;
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
        return `Travel to ${dst} to deliver your ${hint.qty.toFixed(0)} ${goodName(hint.good)} for the contract — expected net Ç${Math.round(hint.expectedNet).toLocaleString()}.`;
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
    case "wait":
      return hint.reason;
  }
}

// markers used by the UI to highlight elements
export interface HintTarget {
  buyGood?: GoodId;
  buyQty?: number;             // engine's recommended buy qty — leaves room for contract goods
  sellGood?: GoodId;
  travelTo?: LocationId;
  refuel?: boolean;
  critical?: boolean;
  acceptJobId?: JobId;
}

export function hintTarget(hint: GuidedHint): HintTarget {
  switch (hint.kind) {
    case "buy_for_route":
      return { buyGood: hint.good, buyQty: hint.qty };
    case "travel_to_sell":
      return { travelTo: hint.dst };
    case "sell_here":
      return { sellGood: hint.good };
    case "refuel":
      return { refuel: true, critical: hint.critical };
    case "speculate":
      return { travelTo: hint.via };
    case "accept_job":
      return { acceptJobId: hint.jobId };
    case "wait":
      return {};
  }
}
