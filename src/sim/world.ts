import type { Good, GoodId, LocationDef, LocationId, MarketState, World } from "./types";
import { GOODS } from "./data/goods";
import { LOCATIONS, DISTANCES } from "./data/locations";

export function createWorld(opts?: {
  goods?: Record<GoodId, Good>;
  locations?: Record<LocationId, LocationDef>;
  distances?: Record<LocationId, Record<LocationId, number>>;
}): World {
  const goods = opts?.goods ?? GOODS;
  const locations = opts?.locations ?? LOCATIONS;
  const distances = opts?.distances ?? DISTANCES;

  const markets: Record<LocationId, MarketState> = {};
  for (const loc of Object.values(locations)) {
    const stock: Record<GoodId, number> = {};
    const prices: Record<GoodId, number> = {};
    for (const goodId of Object.keys(goods)) {
      stock[goodId] = loc.targetStock[goodId] ?? 0;
      prices[goodId] = goods[goodId].basePrice;
    }
    markets[loc.id] = { stock, prices };
  }

  return { tick: 0, goods, locations, markets, distances };
}
