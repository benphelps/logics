import type { GoodId, LocationDef, LocationId, MarketState, World } from "./types";

export const PRICE_ELASTICITY = 0.6;
export const PRICE_FLOOR_MULT = 0.25;
export const PRICE_CEILING_MULT = 5.0;
export const PRICE_RESERVE_FRACTION = 0.08;

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
    const base = world.goods[goodId].basePrice;
    if (world.goods[goodId].category === "upgrade") {
      market.prices[goodId] = base;
      continue;
    }
    const target = loc.targetStock[goodId] ?? 0;
    if (target <= 0) {
      market.prices[goodId] = base;
    } else {
      market.prices[goodId] = priceFor(base, market.stock[goodId] ?? 0, target);
    }
  }
}
