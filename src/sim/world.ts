import type { Good, GoodId, LaneMap, LocationDef, LocationId, MarketState, Player, Trader, TraderId, World } from "./types";
import { GOODS } from "./data/goods";
import { LOCATIONS, LANES } from "./data/locations";
import { STARTER_TRADERS } from "./data/traders";
import { DEFAULT_PLAYER_SEED, makePlayer, type PlayerSeedConfig } from "./data/player";
import { defaultTreasuryTarget } from "./economy";
import { ensureStockMarket } from "./stock";

export function createWorld(opts?: {
  goods?: Record<GoodId, Good>;
  locations?: Record<LocationId, LocationDef>;
  lanes?: LaneMap;
  traders?: Record<TraderId, Trader>;
  player?: Player | null | PlayerSeedConfig;
}): World {
  const goods = opts?.goods ?? GOODS;
  const locations = opts?.locations ?? LOCATIONS;
  const lanes = opts?.lanes ?? LANES;
  const traders: Record<TraderId, Trader> = structuredClone(opts?.traders ?? STARTER_TRADERS);

  let player: Player | null;
  if (opts?.player === null) {
    player = null;
  } else if (opts?.player && "shipIds" in opts.player) {
    player = structuredClone(opts.player);
  } else if (opts?.player !== undefined) {
    const seed = opts.player as PlayerSeedConfig;
    const made = makePlayer(seed);
    if (locations[made.ship.location]) {
      traders[made.ship.id] = made.ship;
      player = made.player;
    } else {
      player = null;
    }
  } else {
    const made = makePlayer(DEFAULT_PLAYER_SEED);
    if (locations[made.ship.location]) {
      traders[made.ship.id] = made.ship;
      player = made.player;
    } else {
      player = null;
    }
  }

  const markets: Record<LocationId, MarketState> = {};
  for (const loc of Object.values(locations)) {
    const stock: Record<GoodId, number> = {};
    const prices: Record<GoodId, number> = {};
    for (const goodId of Object.keys(goods)) {
      stock[goodId] = loc.targetStock[goodId] ?? 0;
      prices[goodId] = goods[goodId].basePrice;
    }
    const treasuryTarget = defaultTreasuryTarget(loc);
    markets[loc.id] = { stock, prices, treasury: treasuryTarget, treasuryTarget };
  }

  const world: World = {
    tick: 0, goods, locations, markets, lanes, traders, player,
    jobs: {}, nextJobId: 1, hires: {}, nextHireId: 1,
    equities: {}, syndicates: {},
  };
  ensureStockMarket(world);
  return world;
}
