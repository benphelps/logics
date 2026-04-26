import type { FuelType, GoodId, LocationId, Trader, World } from "./types";
import { distance, nearestDistance } from "./geometry";
import { priceFor } from "./pricing";
import { MAINTENANCE_PER_CAPACITY } from "./economy";

export const MIN_PROFIT_PER_TICK = 0.05;
export const MAX_DRAW_FRACTION = 0.5;
export const REFUEL_THRESHOLD = 0.4;
export const STRANDING_RESERVE = 0.2;
export const INFLIGHT_WEIGHT = 0.3;

export interface TraderEvent {
  trader: string;
  kind: "buy" | "sell" | "depart" | "arrive" | "idle" | "refuel" | "stuck";
  good?: GoodId;
  qty?: number;
  unitPrice?: number;
  from?: LocationId;
  to?: LocationId;
}

interface TradeOption {
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

function activeFuelType(trader: Trader): FuelType | null {
  if (!trader.currentFuel) return null;
  return trader.fuelTypes.find(f => f.good === trader.currentFuel!.good) ?? null;
}

function selectRefuelType(world: World, trader: Trader): FuelType | null {
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
    if (t.state === "transit" && t.destination && t.cargo) {
      const key = `${t.destination}|${t.cargo.good}`;
      acc.set(key, (acc.get(key) ?? 0) + t.cargo.qty);
    }
  }
  return acc;
}

function evaluateOptions(world: World, trader: Trader, inflight: Map<string, number>): TradeOption | null {
  const here = trader.location;
  const srcMarket = world.markets[here];
  const fuel = trader.currentFuel;
  const ft = activeFuelType(trader);
  if (!fuel || !ft) return null;
  const localFuelPrice = srcMarket.prices[fuel.good];
  let best: TradeOption | null = null;

  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const good = world.goods[goodId];
    const buyPrice = srcMarket.prices[goodId];
    const srcStock = srcMarket.stock[goodId] ?? 0;
    const maxByCargo = trader.capacity / good.weight;
    const maxByStock = srcStock * MAX_DRAW_FRACTION;
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
      const inflightToDst = inflight.get(`${dstId}|${goodId}`) ?? 0;
      const dstStockAfter = dstStockNow + INFLIGHT_WEIGHT * inflightToDst + maxQty;
      const sellPrice = dstTarget > 0
        ? priceFor(world.goods[goodId].basePrice, dstStockAfter, dstTarget)
        : dstMarket.prices[goodId];
      const fuelCost = fuelNeeded * localFuelPrice;
      const grossProfitPerUnit = sellPrice - buyPrice - fuelCost / maxQty;
      if (grossProfitPerUnit <= 0) continue;

      const travelTicks = Math.max(1, Math.ceil(dist / trader.speed));
      const tripMaintenance = travelTicks * trader.capacity * MAINTENANCE_PER_CAPACITY;
      const totalProfit = grossProfitPerUnit * maxQty - tripMaintenance;
      if (totalProfit <= 0) continue;
      const profitPerTick = totalProfit / (travelTicks + 1);
      if (profitPerTick < MIN_PROFIT_PER_TICK) continue;

      if (!best || profitPerTick > best.profitPerTick) {
        best = {
          good: goodId,
          to: dstId,
          qty: maxQty,
          buyPrice,
          sellPrice,
          travelTicks,
          fuelNeeded,
          totalProfit,
          profitPerTick,
        };
      }
    }
  }

  return best;
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

    if (trader.cargo) {
      const dstMarket = world.markets[dst];
      const { good, qty } = trader.cargo;
      const unitPrice = dstMarket.prices[good];
      dstMarket.stock[good] = (dstMarket.stock[good] ?? 0) + qty;
      trader.funds += qty * unitPrice;
      trader.cargo = null;
      events.push({ trader: trader.id, kind: "sell", good, qty, unitPrice, to: dst });
    }
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
  trader.cargo = { good: choice.good, qty: choice.qty };
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

export function stepTraders(world: World): TraderEvent[] {
  const events: TraderEvent[] = [];
  const inflight = inTransitArrivalsByDestGood(world);
  for (const trader of Object.values(world.traders)) {
    stepTrader(world, trader, events, inflight);
  }
  return events;
}
