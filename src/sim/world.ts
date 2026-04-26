import type { Good, GoodId, LaneMap, LocationDef, LocationId, MarketState, Trader, TraderId, World } from "./types";
import { GOODS } from "./data/goods";
import { LOCATIONS, LANES } from "./data/locations";
import { STARTER_TRADERS } from "./data/traders";

export function createWorld(opts?: {
  goods?: Record<GoodId, Good>;
  locations?: Record<LocationId, LocationDef>;
  lanes?: LaneMap;
  traders?: Record<TraderId, Trader>;
}): World {
  const goods = opts?.goods ?? GOODS;
  const locations = opts?.locations ?? LOCATIONS;
  const lanes = opts?.lanes ?? LANES;
  const traders = structuredClone(opts?.traders ?? STARTER_TRADERS);

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

  return { tick: 0, goods, locations, markets, lanes, traders };
}
