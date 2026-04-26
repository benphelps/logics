import type { GoodId, LocationDef, MarketState, World } from "./types";

export const PRICE_ELASTICITY = 0.6;
export const PRICE_FLOOR_MULT = 0.25;
export const PRICE_CEILING_MULT = 5.0;

export function priceFor(
  basePrice: number,
  stock: number,
  target: number,
): number {
  if (target <= 0) return basePrice;
  const safeStock = Math.max(stock, 0.001);
  const ratio = Math.pow(target / safeStock, PRICE_ELASTICITY);
  const clamped = Math.min(PRICE_CEILING_MULT, Math.max(PRICE_FLOOR_MULT, ratio));
  return basePrice * clamped;
}

export function recomputePrices(world: World, loc: LocationDef, market: MarketState): void {
  for (const goodId of Object.keys(world.goods) as GoodId[]) {
    const target = loc.targetStock[goodId] ?? 0;
    const base = world.goods[goodId].basePrice;
    if (target <= 0) {
      market.prices[goodId] = base;
    } else {
      market.prices[goodId] = priceFor(base, market.stock[goodId] ?? 0, target);
    }
  }
}
