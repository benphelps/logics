// Single API for reading news-event multipliers: eventMultiplier(world, scope, ctx).
// Returns 1 when newsEvents is undefined, disabled, or has no matching active
// events. Cached per-tick in a module WeakMap so the cache rides on the world
// object without leaking into save data.

import type { World } from "../types";
import type { NewsCtx, NewsScope, NewsTarget } from "./types";

interface CacheEntry {
  tick: number;
  values: Map<string, number>;
}
const cache = new WeakMap<World, CacheEntry>();

const MIN_MULT = 0.25;
const MAX_MULT = 4.0;

export function eventMultiplier(world: World, scope: NewsScope, ctx?: NewsCtx): number {
  const state = world.newsEvents;
  if (!state || !state.enabled || state.active.length === 0) return 1;

  let entry = cache.get(world);
  if (!entry || entry.tick !== world.tick) {
    entry = { tick: world.tick, values: new Map() };
    cache.set(world, entry);
  }
  const key = cacheKey(scope, ctx);
  const cached = entry.values.get(key);
  if (cached !== undefined) return cached;

  let m = 1;
  for (const ev of state.active) {
    for (const eff of ev.effects) {
      if (eff.scope !== scope) continue;
      if (!targetMatches(world, eff.target, ctx)) continue;
      m *= 1 + eff.direction * eff.magnitude;
    }
  }
  if (m < MIN_MULT) m = MIN_MULT;
  else if (m > MAX_MULT) m = MAX_MULT;

  entry.values.set(key, m);
  return m;
}

export function invalidateEventCache(world: World): void {
  cache.delete(world);
}

function cacheKey(scope: NewsScope, ctx?: NewsCtx): string {
  return `${scope}|${ctx?.locationId ?? "*"}|${ctx?.goodId ?? "*"}|${ctx?.syndicateId ?? "*"}|${ctx?.indexId ?? "*"}|${ctx?.category ?? "*"}`;
}

function targetMatches(world: World, target: NewsTarget, ctx?: NewsCtx): boolean {
  switch (target.kind) {
    case "global": return true;
    case "good": {
      if (!ctx?.goodId) return false;
      if (target.id) return target.id === ctx.goodId;
      if (target.category) return world.goods[ctx.goodId]?.category === target.category;
      return true;
    }
    case "location": {
      if (!ctx?.locationId) return false;
      if (target.id) return target.id === ctx.locationId;
      if (target.category) return world.locations[ctx.locationId]?.traits.faction === target.category;
      return true;
    }
    case "syndicate": {
      if (!ctx?.syndicateId) return false;
      if (target.id) return target.id === ctx.syndicateId;
      return true;
    }
    case "index": {
      if (!ctx?.indexId) return false;
      if (target.id) return target.id === ctx.indexId;
      return true;
    }
  }
}
