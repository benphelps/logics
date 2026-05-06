// Per-subsystem profiler. Mirrors tickWorld() composition but measures
// each phase so we can attribute ms/tick to the responsible code.
//
// Usage: tsx src/sim/scenarios/profile.ts [locations=50] [ticks=300] [warmup=50]
//
// IMPORTANT: scoped small. Does NOT scale to 1000 locations like bench.ts.

import { generateWorld } from "../gen/world";
import { tickWorld } from "../tick";
import { recomputePrices } from "../pricing";
import { tickControl } from "../control";
import { stepTraders } from "../traders";
import {
  applyIdlePerks,
  chargeMaintenance,
  chargeNpcWealthCarry,
  consumptionDemand,
  productionScale,
  tickTreasuries,
} from "../economy";
import { expireJobs, generateJobs } from "../jobs";
import { expireHires, generateHires } from "../hires";
import { tickShipyards } from "../shipyards";
import { replenishUnlockedUpgrades } from "../milestones";
import { commoditySpotPrice, tickStockMarket } from "../stock";
import { runPlayerStockAutopilot } from "../stock/playerAutopilot";
import { tickNewsEvents } from "../news";
import type { LocationDef, MarketState, World } from "../types";

const COMMODITY_SPOT_HISTORY_DEPTH = 100;

function tickCommoditySpotHistory(world: World): void {
  if (!world.commoditySpotHistory) world.commoditySpotHistory = {};
  for (const good of Object.values(world.goods)) {
    const price = commoditySpotPrice(world, good.id, good.basePrice);
    const ring = world.commoditySpotHistory[good.id] ?? (world.commoditySpotHistory[good.id] = []);
    ring.push({ tick: world.tick, price });
    if (ring.length > COMMODITY_SPOT_HISTORY_DEPTH) {
      ring.splice(0, ring.length - COMMODITY_SPOT_HISTORY_DEPTH);
    }
  }
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

function consume(loc: LocationDef, market: MarketState): void {
  for (const entry of loc.consumes) {
    const have = market.stock[entry.good] ?? 0;
    const want = entry.ratePerTick;
    const target = loc.targetStock[entry.good] ?? 0;
    const taken = consumptionDemand(have, want, target);
    market.stock[entry.good] = Math.max(0, have - taken);
  }
}

interface PhaseTimes {
  news: number;
  traders: number;
  prodConsume: number;
  recomputePrices: number;
  maintenance: number;
  idlePerks: number;
  npcCarry: number;
  treasuries: number;
  spotHistory: number;
  playerAutopilot: number;
  stockMarket: number;
  jobsExpire: number;
  jobsGen: number;
  hiresExpire: number;
  hiresGen: number;
  shipyards: number;
  upgrades: number;
  control: number;
}

function newPhases(): PhaseTimes {
  return {
    news: 0, traders: 0, prodConsume: 0, recomputePrices: 0,
    maintenance: 0, idlePerks: 0, npcCarry: 0, treasuries: 0,
    spotHistory: 0, playerAutopilot: 0, stockMarket: 0,
    jobsExpire: 0, jobsGen: 0, hiresExpire: 0, hiresGen: 0,
    shipyards: 0, upgrades: 0, control: 0,
  };
}

function measuredTick(world: World, p: PhaseTimes): void {
  let t = performance.now();
  tickNewsEvents(world);
  p.news += performance.now() - t;

  t = performance.now();
  stepTraders(world);
  p.traders += performance.now() - t;

  t = performance.now();
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    produce(loc, market);
    consume(loc, market);
  }
  p.prodConsume += performance.now() - t;

  t = performance.now();
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    recomputePrices(world, loc, market);
  }
  p.recomputePrices += performance.now() - t;

  t = performance.now();
  chargeMaintenance(world);
  p.maintenance += performance.now() - t;

  t = performance.now();
  applyIdlePerks(world);
  p.idlePerks += performance.now() - t;

  t = performance.now();
  chargeNpcWealthCarry(world);
  p.npcCarry += performance.now() - t;

  t = performance.now();
  tickTreasuries(world);
  p.treasuries += performance.now() - t;

  t = performance.now();
  tickCommoditySpotHistory(world);
  p.spotHistory += performance.now() - t;

  t = performance.now();
  runPlayerStockAutopilot(world);
  p.playerAutopilot += performance.now() - t;

  t = performance.now();
  tickStockMarket(world);
  p.stockMarket += performance.now() - t;

  t = performance.now();
  expireJobs(world);
  p.jobsExpire += performance.now() - t;

  t = performance.now();
  generateJobs(world);
  p.jobsGen += performance.now() - t;

  t = performance.now();
  expireHires(world);
  p.hiresExpire += performance.now() - t;

  t = performance.now();
  generateHires(world);
  p.hiresGen += performance.now() - t;

  t = performance.now();
  tickShipyards(world);
  p.shipyards += performance.now() - t;

  t = performance.now();
  replenishUnlockedUpgrades(world);
  p.upgrades += performance.now() - t;

  t = performance.now();
  tickControl(world);
  p.control += performance.now() - t;

  world.tick += 1;
}

function fmt(n: number, w = 8, d = 2): string {
  return n.toFixed(d).padStart(w);
}

function profile(seed: number, locationCount: number, ticks: number, warmup: number) {
  const world = generateWorld({
    seed,
    locationCount,
    traderCount: Math.max(2, Math.round(locationCount * 1.5)),
  });

  // Warm up using the production tickWorld so any lazy init paths fire.
  for (let i = 0; i < warmup; i++) tickWorld(world);

  const p = newPhases();
  const start = performance.now();
  for (let i = 0; i < ticks; i++) measuredTick(world, p);
  const totalMs = performance.now() - start;

  const traderCount = Object.keys(world.traders).length;
  const equityCount = Object.keys(world.equities).length;
  const goodCount = Object.keys(world.goods).length;
  const jobCount = Object.keys(world.jobs).length;

  console.log(`\n=== Profile (seed=${seed}) ===`);
  console.log(`Locations: ${locationCount}  Traders: ${traderCount}  Goods: ${goodCount}  Equities: ${equityCount}  Open jobs: ${jobCount}`);
  console.log(`Ticks measured: ${ticks} (after ${warmup} warmup ticks)`);
  console.log(`Total ms: ${fmt(totalMs, 8, 1)}   ms/tick: ${fmt(totalMs / ticks, 8, 3)}   ticks/s: ${fmt(1000 / (totalMs / ticks), 8, 0)}`);

  const phases: [keyof PhaseTimes, string][] = [
    ["traders", "stepTraders"],
    ["stockMarket", "tickStockMarket"],
    ["recomputePrices", "recomputePrices"],
    ["jobsGen", "generateJobs"],
    ["control", "tickControl"],
    ["spotHistory", "commoditySpotHistory"],
    ["prodConsume", "produce+consume"],
    ["treasuries", "tickTreasuries"],
    ["maintenance", "chargeMaintenance"],
    ["npcCarry", "chargeNpcWealthCarry"],
    ["idlePerks", "applyIdlePerks"],
    ["news", "tickNewsEvents"],
    ["jobsExpire", "expireJobs"],
    ["hiresGen", "generateHires"],
    ["hiresExpire", "expireHires"],
    ["shipyards", "tickShipyards"],
    ["upgrades", "replenishUpgrades"],
    ["playerAutopilot", "playerStockAutopilot"],
  ];
  const phaseSum = phases.reduce((s, [k]) => s + p[k], 0);

  console.log(`\nPer-phase breakdown (sum = ${fmt(phaseSum, 7, 1)}ms / total measured = ${fmt(totalMs, 7, 1)}ms):`);
  console.log("phase                       total_ms   ms/tick   pct_of_phases");
  console.log("──────────────────────────  ────────  ────────  ─────────────");
  const sorted = [...phases].sort((a, b) => p[b[0]] - p[a[0]]);
  for (const [k, label] of sorted) {
    const ms = p[k];
    const pct = phaseSum > 0 ? (ms / phaseSum) * 100 : 0;
    console.log(
      `${label.padEnd(26)}  ${fmt(ms, 8, 1)}  ${fmt(ms / ticks, 8, 4)}  ${fmt(pct, 12, 1)}%`,
    );
  }
}

const args = process.argv.slice(2);
const LOCS = Number(args[0] ?? 50);
const TICKS = Number(args[1] ?? 300);
const WARMUP = Number(args[2] ?? 50);
const SEED = 42;

profile(SEED, LOCS, TICKS, WARMUP);
