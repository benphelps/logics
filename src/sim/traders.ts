import type { FuelType, GoodId, LocationId, Trader, TraderEvent, World } from "./types";
import { distance, nearestDistance } from "./geometry";
import { priceFor } from "./pricing";
import { chargeDockingFee, DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";
import { acceptJob, creditJobOnDelivery, type JobCompletionEvent } from "./jobs";
import { pushNote, pushTraderEvent } from "./log";
import { effectivePerDistance, hasCrew, MAINTENANCE_DEBT_TRAVEL_BLOCK } from "./crew";

export const MIN_PROFIT_PER_TICK = 0.05;
export const MAX_DRAW_FRACTION = 0.5;
export const REFUEL_THRESHOLD = 0.6;          // refuel earlier — was 0.4
export const STRANDING_RESERVE = 0.3;         // require 30% reserve at arrival — was 0.2
export const INFLIGHT_WEIGHT = 1.0;

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
  const affordable = price > 0 ? trader.funds / price : 0;
  const buyQty = Math.min(need, stock, affordable);
  if (buyQty <= 0.001) return;

  market.stock[choice.good] = stock - buyQty;
  trader.funds -= buyQty * price;
  trader.currentFuel = { good: choice.good, qty: currentQty + buyQty };

  events.push({ trader: trader.id, kind: "refuel", good: choice.good, qty: buyQty, unitPrice: price });
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
  const jobBonusMap = new Map<string, { perUnit: number; remaining: number }>();
  for (const j of Object.values(world.jobs)) {
    if (j.acceptedBy !== trader.id) continue;
    const remaining = j.qty - j.delivered;
    if (remaining <= 0) continue;
    jobBonusMap.set(`${j.destination}|${j.good}`, { perUnit: j.reward / j.qty, remaining });
  }

  // Cargo space available for new buys = capacity - existing lot mass.
  // Lets the suggestion engine recommend "hedge" buys when the player has
  // partial cargo — without this, every buy was sized to full empty bay.
  const usedMass = trader.cargo.reduce((s, l) => s + l.qty * world.goods[l.good].weight, 0);
  const freeMass = Math.max(0, trader.capacity - usedMass);

  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const good = world.goods[goodId];
    const buyPrice = srcMarket.prices[goodId];
    const srcStock = srcMarket.stock[goodId] ?? 0;
    const maxByCargo = freeMass / good.weight;
    const maxByStock = srcStock * drawFraction;
    const maxByFunds = buyPrice > 0 ? trader.funds / buyPrice : 0;
    const maxQty = Math.floor(Math.min(maxByCargo, maxByStock, maxByFunds));
    if (maxQty <= 0) continue;

    const perDist = effectivePerDistance(trader, ft.perDistance);
    for (const dstId of Object.keys(world.locations) as LocationId[]) {
      if (dstId === here) continue;
      const dist = distance(world, here, dstId);
      const fuelNeeded = dist * perDist;
      if (fuelNeeded > effectiveFuel) continue;

      const dstMarket = world.markets[dstId];
      const fuelAfter = effectiveFuel - fuelNeeded;
      const dstHasMyFuel = trader.fuelTypes.some(
        f => (dstMarket.stock[f.good] ?? 0) >= trader.fuelCapacity * REFUEL_THRESHOLD,
      );
      const safeReserve = fuelAfter >= trader.fuelCapacity * STRANDING_RESERVE;
      if (!dstHasMyFuel && !safeReserve) continue;

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
      const jobMatch = jobBonusMap.get(`${dstId}|${goodId}`);
      if (jobMatch) totalProfit += Math.min(maxQty, jobMatch.remaining) * jobMatch.perUnit;
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
      });
    }
  }

  options.sort((a, b) => b.profitPerTick - a.profitPerTick);
  return options;
}

function evaluateOptions(world: World, trader: Trader, inflight: Map<string, number>): TradeOption | null {
  const opts = listTradeOptions(world, trader, inflight);
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
  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return [];
  const here = trader.location;
  const hereMarket = world.markets[here];
  const localFuelPrice = hereMarket.prices[fuel.good] ?? 0;
  const out: SpeculativeOption[] = [];

  // Sort candidate via-points by distance and only consider the K nearest.
  // Long empty trips rarely repay their positioning cost anyway.
  const candidates = (Object.keys(world.locations) as LocationId[])
    .filter(id => id !== here)
    .map(id => ({ id, dist: distance(world, here, id) }))
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
  const minDist = nearestDistance(world, trader.location);
  if (minDist === 0) return false;
  return trader.currentFuel.qty < minDist * effectivePerDistance(trader, ft.perDistance);
}

function stepTrader(world: World, trader: Trader, events: TraderEvent[], inflight: Map<string, number>): void {
  if (trader.state === "transit") {
    trader.ticksRemaining -= 1;
    if (trader.ticksRemaining > 0) return;

    const dst = trader.destination!;
    trader.location = dst;
    trader.destination = null;
    trader.state = "idle";
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
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  // Player ships in auto mode require a captain on the crew. Without one
  // they sit idle just like manual ships — the player must hire to unlock
  // autonomous trading. NPCs (pilot === "npc") never have crew; their auto
  // behavior is implicit.
  if (trader.pilot === "auto" && !hasCrew(trader, "captain")) {
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  tryRefuel(world, trader, events);

  const choice = evaluateOptions(world, trader, inflight);
  if (!choice) {
    // No direct trade — try speculative travel: empty trip to a station
    // where a profitable trade exists, even after positioning costs.
    if (trader.cargo.length === 0) {
      const speculative = listSpeculativeOptions(world, trader);
      const sp = speculative[0];
      if (sp) {
        // Depart empty for the via point. On arrival, refuel + take the
        // best trade from there (which we'll re-evaluate next tick).
        const here = trader.location;
        trader.currentFuel = { good: trader.currentFuel!.good, qty: trader.currentFuel!.qty - sp.emptyFuelNeeded };
        trader.destination = sp.via;
        trader.state = "transit";
        trader.ticksRemaining = sp.emptyTravelTicks;
        events.push({ trader: trader.id, kind: "depart", from: here, to: sp.via });
        return;
      }
    }
    events.push({ trader: trader.id, kind: isStuck(world, trader) ? "stuck" : "idle" });
    return;
  }

  const here = trader.location;
  const srcMarket = world.markets[here];
  srcMarket.stock[choice.good] = (srcMarket.stock[choice.good] ?? 0) - choice.qty;
  trader.funds -= choice.qty * choice.buyPrice;
  trader.cargo = [{
    good: choice.good,
    qty: choice.qty,
    source: here,
    unitPrice: choice.buyPrice,
    purchasedAt: world.tick,
  }];
  trader.currentFuel = { good: trader.currentFuel!.good, qty: trader.currentFuel!.qty - choice.fuelNeeded };
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
  trader.ticksRemaining = choice.travelTicks;
  events.push({ trader: trader.id, kind: "depart", from: here, to: choice.to });

  const key = `${choice.to}|${choice.good}`;
  inflight.set(key, (inflight.get(key) ?? 0) + choice.qty);
}

export type ExecuteResult =
  | { ok: true; events: TraderEvent[]; jobCompletions?: JobCompletionEvent[] }
  | { ok: false; reason: string };

export function executeTrade(world: World, trader: Trader, choice: TradeOption): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };

  const here = trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const ft = activeFuelType(trader);
  if (!fuel || !ft) return { ok: false, reason: "No compatible fuel in tank." };
  if (fuel.qty < choice.fuelNeeded) return { ok: false, reason: "Not enough fuel for this trip." };
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
  trader.currentFuel = { good: fuel.good, qty: fuel.qty - choice.fuelNeeded };
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
  trader.ticksRemaining = choice.travelTicks;
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

  // Maintenance debt over the threshold grounds the ship until it's repaired.
  // Player-side gating only — NPCs don't carry debt.
  if ((trader.maintenanceDebt ?? 0) >= MAINTENANCE_DEBT_TRAVEL_BLOCK) {
    return { ok: false, reason: `Maintenance debt Ç${Math.round(trader.maintenanceDebt!).toLocaleString()} too high — repair ship before travel.` };
  }

  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return { ok: false, reason: "No compatible fuel in tank." };

  const dist = distance(world, trader.location, dst);
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
// player ships missing a mechanic. Returns the amount paid.
export function repairShip(world: World, trader: Trader): { ok: true; paid: number } | { ok: false; reason: string } {
  if (trader.state !== "idle") return { ok: false, reason: "Can only repair while docked." };
  const debt = trader.maintenanceDebt ?? 0;
  if (debt <= 0) return { ok: false, reason: "Ship is in good repair — nothing to fix." };
  if (!world.player) return { ok: false, reason: "No player." };
  if (world.player.funds < debt) {
    return { ok: false, reason: `Need Ç${Math.round(debt).toLocaleString()} to repair, have Ç${Math.round(world.player.funds).toLocaleString()}.` };
  }
  world.player.funds -= debt;
  trader.maintenanceDebt = 0;
  pushNote(world, trader, `Repaired ship — Ç${Math.round(debt).toLocaleString()} paid`, "good");
  return { ok: true, paid: debt };
}

export function stepTraders(world: World): TraderEvent[] {
  const events: TraderEvent[] = [];
  const inflight = inTransitArrivalsByDestGood(world);
  for (const trader of Object.values(world.traders)) {
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
