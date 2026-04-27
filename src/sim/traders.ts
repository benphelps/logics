import type { FuelType, GoodId, LocationId, Trader, World } from "./types";
import { distance, nearestDistance } from "./geometry";
import { priceFor } from "./pricing";
import { chargeDockingFee, DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";

export const MIN_PROFIT_PER_TICK = 0.05;
export const MAX_DRAW_FRACTION = 0.5;
export const REFUEL_THRESHOLD = 0.4;
export const STRANDING_RESERVE = 0.2;
export const INFLIGHT_WEIGHT = 1.0;

export interface TraderEvent {
  trader: string;
  kind: "buy" | "sell" | "depart" | "arrive" | "idle" | "refuel" | "stuck";
  good?: GoodId;
  qty?: number;
  unitPrice?: number;
  from?: LocationId;
  to?: LocationId;
}

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
): TradeOption[] {
  const inflightMap = inflight ?? inTransitArrivalsByDestGood(world);
  const here = trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const ft = activeFuelType(trader);
  if (!fuel || !ft) return [];
  const localFuelPrice = srcMarket.prices[fuel.good];
  const options: TradeOption[] = [];

  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const good = world.goods[goodId];
    const buyPrice = srcMarket.prices[goodId];
    const srcStock = srcMarket.stock[goodId] ?? 0;
    const maxByCargo = trader.capacity / good.weight;
    const maxByStock = srcStock * drawFraction;
    const maxByFunds = buyPrice > 0 ? trader.funds / buyPrice : 0;
    const maxQty = Math.floor(Math.min(maxByCargo, maxByStock, maxByFunds));
    if (maxQty <= 0) continue;

    for (const dstId of Object.keys(world.locations) as LocationId[]) {
      if (dstId === here) continue;
      const dist = distance(world, here, dstId);
      const fuelNeeded = dist * ft.perDistance;
      if (fuelNeeded > fuel.qty) continue;

      const dstMarket = world.markets[dstId];
      const fuelAfter = fuel.qty - fuelNeeded;
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
      const totalProfit = grossProfitPerUnit * maxQty - tripMaintenance - tripDockingFee;
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

function isStuck(world: World, trader: Trader): boolean {
  const ft = activeFuelType(trader);
  if (!ft || !trader.currentFuel || trader.currentFuel.qty <= 0) return true;
  const minDist = nearestDistance(world, trader.location);
  if (minDist === 0) return false;
  return trader.currentFuel.qty < minDist * ft.perDistance;
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
      const dstMarket = world.markets[dst];
      for (const lot of trader.cargo) {
        const { good, qty } = lot;
        const unitPrice = dstMarket.prices[good];
        dstMarket.stock[good] = (dstMarket.stock[good] ?? 0) + qty;
        const netUnitPrice = unitPrice * (1 - SALES_TAX_RATE);
        trader.funds += qty * netUnitPrice;
        events.push({ trader: trader.id, kind: "sell", good, qty, unitPrice: netUnitPrice, to: dst });
      }
      trader.cargo = [];
    }
    return;
  }

  if (trader.pilot === "manual") {
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  tryRefuel(world, trader, events);

  const choice = evaluateOptions(world, trader, inflight);
  if (!choice) {
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
  | { ok: true; events: TraderEvent[] }
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
  addOrMergeCargoLot(trader, choice.good, choice.qty, here, choice.buyPrice, world.tick);
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

  return { ok: true, events };
}

function addOrMergeCargoLot(
  trader: Trader,
  goodId: GoodId,
  qty: number,
  source: string,
  unitPrice: number,
  tick: number,
): void {
  const existing = trader.cargo.find(l => l.good === goodId);
  if (existing) {
    // Weighted-average cost basis on incremental adds; source updates to
    // most recent purchase; purchasedAt stays as the original first purchase.
    const oldQty = existing.qty;
    const oldCost = oldQty * existing.unitPrice;
    const newQty = oldQty + qty;
    existing.qty = newQty;
    existing.unitPrice = (oldCost + qty * unitPrice) / newQty;
    existing.source = source;
  } else {
    trader.cargo.push({ good: goodId, qty, source, unitPrice, purchasedAt: tick });
  }
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
  addOrMergeCargoLot(trader, goodId, qty, trader.location, price, world.tick);

  return {
    ok: true,
    events: [{ trader: trader.id, kind: "buy", good: goodId, qty, unitPrice: price, from: trader.location }],
  };
}

export function sellAtLocation(world: World, trader: Trader, goodId: GoodId, qty?: number): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is in transit." };
  const lotIdx = trader.cargo.findIndex(l => l.good === goodId);
  if (lotIdx < 0) return { ok: false, reason: `No ${goodId} in cargo.` };
  const lot = trader.cargo[lotIdx];

  const sellQty = qty ?? lot.qty;
  if (sellQty <= 0) return { ok: false, reason: "Quantity must be positive." };
  if (sellQty > lot.qty + 0.001) return { ok: false, reason: `Only have ${lot.qty} units of ${goodId}.` };

  const market = world.markets[trader.location];
  const grossPrice = market.prices[goodId];
  const netPrice = grossPrice * (1 - SALES_TAX_RATE);
  const revenue = sellQty * netPrice;

  market.stock[goodId] = (market.stock[goodId] ?? 0) + sellQty;
  trader.funds += revenue;
  const remaining = lot.qty - sellQty;
  if (remaining > 0.001) {
    lot.qty = remaining;
  } else {
    trader.cargo.splice(lotIdx, 1);
  }

  return {
    ok: true,
    events: [{ trader: trader.id, kind: "sell", good: goodId, qty: sellQty, unitPrice: netPrice, to: trader.location }],
  };
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

  return {
    ok: true,
    events: [{ trader: trader.id, kind: "refuel", good: ft.good, qty: buyQty, unitPrice: price }],
  };
}

export function travelTo(world: World, trader: Trader, dst: LocationId): ExecuteResult {
  if (trader.state !== "idle") return { ok: false, reason: "Ship is already in transit." };
  if (dst === trader.location) return { ok: false, reason: "Already at destination." };
  if (!world.locations[dst]) return { ok: false, reason: "Unknown destination." };

  const ft = activeFuelType(trader);
  const fuel = trader.currentFuel;
  if (!ft || !fuel) return { ok: false, reason: "No compatible fuel in tank." };

  const dist = distance(world, trader.location, dst);
  const fuelNeeded = dist * ft.perDistance;
  if (fuel.qty < fuelNeeded - 0.001) {
    return { ok: false, reason: `Need ${fuelNeeded.toFixed(1)} fuel, have ${fuel.qty.toFixed(1)}.` };
  }

  const travelTicks = Math.max(1, Math.ceil(dist / trader.speed));

  trader.currentFuel = { good: fuel.good, qty: fuel.qty - fuelNeeded };
  trader.destination = dst;
  trader.state = "transit";
  trader.ticksRemaining = travelTicks;

  return {
    ok: true,
    events: [{ trader: trader.id, kind: "depart", from: trader.location, to: dst }],
  };
}

export function stepTraders(world: World): TraderEvent[] {
  const events: TraderEvent[] = [];
  const inflight = inTransitArrivalsByDestGood(world);
  for (const trader of Object.values(world.traders)) {
    stepTrader(world, trader, events, inflight);
  }
  return events;
}
