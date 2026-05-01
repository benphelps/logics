import type { GoodId, Hire, HireId, Job, LocationDef, MarketState, World } from "./types";
import { recomputePrices } from "./pricing";
import { stepTraders, type TraderEvent } from "./traders";
import { applyIdlePerks, chargeMaintenance, chargeNpcWealthCarry, consumptionDemand, productionScale, tickTreasuries } from "./economy";
import { expireJobs, generateJobs, type JobExpiryEvent } from "./jobs";
import { expireHires, generateHires } from "./hires";
import { replenishUnlockedUpgrades } from "./milestones";
import { tickStockMarket } from "./stock";
import { runPlayerStockAutopilot } from "./stock/playerAutopilot";
import { getNewsPool, tickNewsEvents } from "./news";
import type { ActiveNewsEvent } from "./news/types";

export interface TickReport {
  tick: number;
  shortages: { location: string; good: GoodId; missing: number }[];
  traderEvents: TraderEvent[];
  jobsPosted: Job[];
  jobsExpired: JobExpiryEvent[];
  hiresPosted: Hire[];
  hiresExpired: HireId[];
  newsSpawned: ActiveNewsEvent[];
  newsExpired: ActiveNewsEvent[];
}

function produce(loc: LocationDef, market: MarketState): void {
  for (const entry of loc.produces) {
    if (entry.requiresTechLevel != null && loc.traits.techLevel < entry.requiresTechLevel) continue;
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
    const target = loc.targetStock[entry.good] ?? 0;
    const taken = consumptionDemand(have, want, target);
    market.stock[entry.good] = Math.max(0, have - taken);
    if (taken < want) shortages.push({ location: loc.id, good: entry.good, missing: want - taken });
  }
}

export function tickWorld(world: World): TickReport {
  const shortages: TickReport["shortages"] = [];

  // Resolve news events first so the freshly-spawned/expired set is visible
  // to price/treasury/stock evaluations later in this same tick.
  const newsReport = tickNewsEvents(world, getNewsPool());

  const traderEvents = stepTraders(world);

  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    produce(loc, market);
    consume(loc, market, shortages);
    recomputePrices(world, loc, market);
  }

  chargeMaintenance(world);

  // Idle-only perks (fuel regen, treasury yield) for ships docked at a
  // station. Runs after maintenance so yield doesn't pay for the same
  // tick's wages.
  applyIdlePerks(world);

  // Wealth-proportional carry tax on NPC traders flows back to local
  // treasuries — a soft cap on long-run NPC fleet wealth.
  chargeNpcWealthCarry(world);

  // City treasuries replenish from the abstract local economy. This is the
  // sole money source in the closed-loop model; it has to balance the
  // sinks (maintenance + crew wages) at steady state.
  tickTreasuries(world);

  // Stock market: recompute share prices from underlying signals (treasury
  // health for stations, fleet wealth for syndicates). Pays quarterly
  // dividends to player shareholders.
  runPlayerStockAutopilot(world);
  tickStockMarket(world);

  // Job board housekeeping. Expire first (so the board has room), then post.
  const jobsExpired = expireJobs(world);
  const jobsPosted = generateJobs(world);

  // Crew hire offers — same expire-then-post pattern.
  const hiresExpired = expireHires(world);
  const hiresPosted = generateHires(world);

  // Milestone-gated upgrade stocking. Idempotent — only seeds tier stock
  // once per (station, upgrade), so post-purchase stays at 0 forever.
  replenishUnlockedUpgrades(world);

  world.tick += 1;
  return {
    tick: world.tick,
    shortages,
    traderEvents,
    jobsPosted,
    jobsExpired,
    hiresPosted,
    hiresExpired,
    newsSpawned: newsReport.spawned,
    newsExpired: newsReport.expired,
  };
}

export function tickN(world: World, n: number): TickReport[] {
  const reports: TickReport[] = [];
  for (let i = 0; i < n; i++) reports.push(tickWorld(world));
  return reports;
}
