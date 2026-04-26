import type { GoodId, LocationId, Trader, World } from "./types";

export const TRANSPORT_RATE = 0.15;
export const MIN_PROFIT_PER_TICK = 0.5;
export const MAX_DRAW_FRACTION = 0.5;

export interface TraderEvent {
  trader: string;
  kind: "buy" | "sell" | "depart" | "arrive" | "idle";
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
  totalProfit: number;
  profitPerTick: number;
}

function evaluateOptions(world: World, trader: Trader): TradeOption | null {
  const here = trader.location;
  const srcMarket = world.markets[here];
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
      const dstMarket = world.markets[dstId];
      const sellPrice = dstMarket.prices[goodId];
      const distance = world.distances[here][dstId];
      const transportPerUnit = distance * good.weight * TRANSPORT_RATE;
      const profitPerUnit = sellPrice - buyPrice - transportPerUnit;
      if (profitPerUnit <= 0) continue;

      const travelTicks = Math.max(1, Math.ceil(distance / trader.speed));
      const totalProfit = profitPerUnit * maxQty;
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
          totalProfit,
          profitPerTick,
        };
      }
    }
  }

  return best;
}

function stepTrader(world: World, trader: Trader, events: TraderEvent[]): void {
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

  const choice = evaluateOptions(world, trader);
  if (!choice) {
    events.push({ trader: trader.id, kind: "idle" });
    return;
  }

  const here = trader.location;
  const srcMarket = world.markets[here];
  srcMarket.stock[choice.good] = (srcMarket.stock[choice.good] ?? 0) - choice.qty;
  trader.funds -= choice.qty * choice.buyPrice;
  trader.cargo = { good: choice.good, qty: choice.qty };
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
}

export function stepTraders(world: World): TraderEvent[] {
  const events: TraderEvent[] = [];
  for (const trader of Object.values(world.traders)) {
    stepTrader(world, trader, events);
  }
  return events;
}
