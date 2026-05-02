import type { Good, GoodId, LaneMap, LocationDef, LocationId, MarketState, Player, Syndicate, SyndicateId, Trader, TraderId, World } from "./types";
import { GOODS } from "./data/goods";
import { LOCATIONS, LANES } from "./data/locations";
import { STARTER_TRADERS } from "./data/traders";
import { DEFAULT_PLAYER_SEED, makePlayer, type PlayerSeedConfig } from "./data/player";
import { defaultTreasuryTarget } from "./economy";
import { ensureStockMarket } from "./stock";
import { createNewsEventsState } from "./news/tick";

export function createWorld(opts?: {
  goods?: Record<GoodId, Good>;
  locations?: Record<LocationId, LocationDef>;
  lanes?: LaneMap;
  traders?: Record<TraderId, Trader>;
  player?: Player | null | PlayerSeedConfig;
  // Pre-built syndicate roster from world gen. Stock-market init reads
  // from world.syndicates: when this is populated up front, ensureStockMarket
  // skips its built-in syndicate fabricator and lists equities for these
  // instead. Omit (or pass {}) for hand-built test worlds — the legacy
  // 4-syndicate fallback fires.
  syndicates?: Record<SyndicateId, Syndicate>;
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
      // Upgrade tiers are milestone-gated — start at stock 0 regardless of
      // targetStock; replenishUnlockedUpgrades will seed each tier the first
      // tick after its milestone is met (and never re-seed afterward, so
      // post-purchase stock stays at 0).
      const isUpgrade = goods[goodId].category === "upgrade";
      stock[goodId] = isUpgrade ? 0 : (loc.targetStock[goodId] ?? 0);
      prices[goodId] = goods[goodId].basePrice;
    }
    const treasuryTarget = defaultTreasuryTarget(loc);
    markets[loc.id] = { stock, prices, treasury: treasuryTarget, treasuryTarget };
  }

  const world: World = {
    gameId: createGameId(),
    tick: 0, goods, locations, markets, lanes, traders, player,
    jobs: {}, nextJobId: 1, hires: {}, nextHireId: 1,
    equities: {}, syndicates: opts?.syndicates ?? {},
    newsEvents: createNewsEventsState(),
  };
  ensureStockMarket(world);
  return world;
}

export function createGameId(): string {
  return `world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
