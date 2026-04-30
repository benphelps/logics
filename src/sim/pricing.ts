import type { GoodId, LocationDef, LocationId, MarketState, World } from "./types";
import { eventMultiplier } from "./news/modifier";

export const PRICE_ELASTICITY = 0.6;
export const PRICE_FLOOR_MULT = 0.25;
export const PRICE_CEILING_MULT = 5.0;
export const PRICE_RESERVE_FRACTION = 0.08;
// Per-tick EMA toward the elasticity-derived target. With 0.10 a 5× swing in
// underlying scarcity halves itself in ~7 ticks, so single-tick stock jolts
// (trader arrivals, production bursts) bleed in gradually instead of teleporting
// the price. Initial market.prices entries are seeded at basePrice and stocks at
// target, so the EMA starts coherent — no migration needed.
export const GOODS_PRICE_SMOOTHING = 0.10;

export function priceFor(
  basePrice: number,
  stock: number,
  target: number,
): number {
  if (target <= 0) return basePrice;
  const reserve = Math.max(0.001, target * PRICE_RESERVE_FRACTION);
  const effectiveStock = Math.max(stock, 0) + reserve;
  const effectiveTarget = target + reserve;
  const ratio = Math.pow(effectiveTarget / effectiveStock, PRICE_ELASTICITY);
  const clamped = Math.min(PRICE_CEILING_MULT, Math.max(PRICE_FLOOR_MULT, ratio));
  return basePrice * clamped;
}

export function marketQuote(world: World, locationId: LocationId, goodId: GoodId): number {
  const good = world.goods[goodId];
  if (!good) return 0;
  if (good.category === "upgrade") return good.basePrice;
  return world.markets[locationId]?.prices[goodId] ?? good.basePrice;
}

export function recomputePrices(world: World, loc: LocationDef, market: MarketState): void {
  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const good = world.goods[goodId];
    const base = good.basePrice;
    if (good.category === "upgrade") {
      // Upgrades bypass scarcity EMA; news events apply directly to base.
      const upgradeMult = eventMultiplier(world, "upgrade_cost", { goodId, locationId: loc.id, category: good.category });
      market.prices[goodId] = base * upgradeMult;
      continue;
    }
    const target = loc.targetStock[goodId] ?? 0;
    const baseResolved = target <= 0 ? base : priceFor(base, market.stock[goodId] ?? 0, target);
    const eventMult = eventMultiplier(world, "commodity_price", { goodId, locationId: loc.id, category: good.category });
    const resolved = baseResolved * eventMult;
    const prev = market.prices[goodId] ?? resolved;
    market.prices[goodId] = prev + GOODS_PRICE_SMOOTHING * (resolved - prev);
  }
}
