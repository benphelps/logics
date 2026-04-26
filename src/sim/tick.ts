import type { GoodId, LocationDef, MarketState, World } from "./types";
import { recomputePrices } from "./pricing";

export interface TickReport {
  tick: number;
  shortages: { location: string; good: GoodId; missing: number }[];
}

function produce(loc: LocationDef, market: MarketState): void {
  for (const entry of loc.produces) {
    let amount = entry.ratePerTick;

    if (entry.inputs && entry.inputs.length > 0) {
      let limit = amount;
      for (const input of entry.inputs) {
        const have = market.stock[input.good] ?? 0;
        const maxFromInput = have / input.perUnit;
        if (maxFromInput < limit) limit = maxFromInput;
      }
      amount = Math.max(0, limit);
      for (const input of entry.inputs) {
        market.stock[input.good] = (market.stock[input.good] ?? 0) - amount * input.perUnit;
      }
    }

    market.stock[entry.good] = (market.stock[entry.good] ?? 0) + amount;
  }
}

function consume(
  loc: LocationDef,
  market: MarketState,
  shortages: TickReport["shortages"],
): void {
  for (const entry of loc.consumes) {
    const have = market.stock[entry.good] ?? 0;
    const want = entry.ratePerTick;
    if (have >= want) {
      market.stock[entry.good] = have - want;
    } else {
      market.stock[entry.good] = 0;
      shortages.push({ location: loc.id, good: entry.good, missing: want - have });
    }
  }
}

export function tickWorld(world: World): TickReport {
  const shortages: TickReport["shortages"] = [];

  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    produce(loc, market);
    consume(loc, market, shortages);
    recomputePrices(world, loc, market);
  }

  world.tick += 1;
  return { tick: world.tick, shortages };
}

export function tickN(world: World, n: number): TickReport[] {
  const reports: TickReport[] = [];
  for (let i = 0; i < n; i++) reports.push(tickWorld(world));
  return reports;
}
