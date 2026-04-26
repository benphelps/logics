import type { GoodId, LocationDef, MarketState, World } from "./types";
import { recomputePrices } from "./pricing";
import { stepTraders, type TraderEvent } from "./traders";
import { chargeMaintenance, productionScale } from "./economy";

export interface TickReport {
  tick: number;
  shortages: { location: string; good: GoodId; missing: number }[];
  traderEvents: TraderEvent[];
}

function produce(loc: LocationDef, market: MarketState): void {
  for (const entry of loc.produces) {
    const target = loc.targetStock[entry.good] ?? 0;
    const currentStock = market.stock[entry.good] ?? 0;
    const scale = productionScale(currentStock, target);
    let amount = entry.ratePerTick * scale;

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

    market.stock[entry.good] = currentStock + amount;
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

  const traderEvents = stepTraders(world);

  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    produce(loc, market);
    consume(loc, market, shortages);
    recomputePrices(world, loc, market);
  }

  chargeMaintenance(world);

  world.tick += 1;
  return { tick: world.tick, shortages, traderEvents };
}

export function tickN(world: World, n: number): TickReport[] {
  const reports: TickReport[] = [];
  for (let i = 0; i < n; i++) reports.push(tickWorld(world));
  return reports;
}
