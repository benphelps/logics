// Long-horizon economy audit harness. Runs the sim across multiple worlds and
// horizons, reporting the metrics that matter for "is this stable + fun".
//
// Usage:
//   npm run audit              -> default suite (4-loc starter + 50-loc gen, 10k + 25k)
//   npm run audit -- 50000     -> override the long horizon
//
// What we care about, in order of importance:
//   1. Invariants stay satisfied past 10k ticks (price clamp, fund floor, stockpile cap)
//   2. NPC fleet wealth doesn't drift exponentially (Tier-2 sinks supposedly hold)
//   3. Stuck-trader rate stays low / recovers
//   4. Trade volume + shortage volume stay roughly stationary (no death spiral)
//   5. Price band utilization isn't pinned at the clamp (means real signal, not floor/ceiling)

import { createWorld } from "../world";
import { generateWorld } from "../gen/world";
import { tickWorld } from "../tick";
import {
  PRICE_CEILING_MULT,
  PRICE_FLOOR_MULT,
} from "../pricing";
import { STOCKPILE_CAP_MULT } from "../economy";
import { isStuck } from "../traders";
import { SHARE_PRICE_CEILING_MULT, SHARE_PRICE_FLOOR_MULT } from "../stock";
import type { World } from "../types";

const HORIZON = Number(process.argv[2] ?? 10_000);
const SAMPLE_INTERVAL = Math.max(50, Math.floor(HORIZON / 50));

interface Sample {
  tick: number;
  totalFunds: number;
  totalCargoValue: number;
  totalTreasury: number;
  totalSystemMoney: number;
  stuckTraders: number;
  inTransitTraders: number;
  tradesSinceLast: number;
  shortageUnitsSinceLast: number;
  jobsCompletedSinceLast: number;
  jobsExpiredSinceLast: number;
  priceClampHits: number;
  priceQuotes: number;
  zeroStockHits: number;
  stockpileSaturated: number;
}

interface AuditReport {
  label: string;
  locations: number;
  traders: number;
  goods: number;
  ticks: number;
  totalMs: number;
  msPerTick: number;
  initialFunds: number;
  finalFunds: number;
  fundsGrowthRatio: number;
  peakFunds: number;
  minFundsAfterWarmup: number;
  brokeTraderTickFraction: number;
  stuckTraderTickFraction: number;
  totalTrades: number;
  tradesPerTickAvg: number;
  totalShortageUnits: number;
  shortageUnitsPerTickAvg: number;
  jobsCompleted: number;
  jobsExpired: number;
  priceClampHitFraction: number;
  zeroStockFraction: number;
  stockpileSaturationFraction: number;
  invariantViolations: string[];
  samples: Sample[];
  // Stock market metrics
  equityCount: number;
  syndicateCount: number;
  finalEquityPriceStats: {
    min: number;
    max: number;
    avg: number;
    pinnedAtCeiling: number;
    pinnedAtFloor: number;
  };
}

function totalCargoValue(world: World): number {
  let v = 0;
  for (const t of Object.values(world.traders)) {
    for (const lot of t.cargo) {
      v += lot.qty * (world.goods[lot.good]?.basePrice ?? 0);
    }
  }
  return v;
}

function audit(world: World, label: string, ticks: number): AuditReport {
  const startFunds = Object.values(world.traders).reduce((s, t) => s + t.funds, 0);

  const samples: Sample[] = [];
  let trades = 0;
  let shortageUnits = 0;
  let jobsCompleted = 0;
  let jobsExpired = 0;
  let totalBrokeTickHits = 0;
  let totalStuckTickHits = 0;
  let totalTraderTicks = 0;

  let segmentTrades = 0;
  let segmentShortage = 0;
  let segmentJobsCompleted = 0;
  let segmentJobsExpired = 0;
  const violations: string[] = [];
  let peakFunds = startFunds;
  let minFundsAfterWarmup = Infinity;

  const start = performance.now();
  for (let i = 0; i < ticks; i++) {
    const r = tickWorld(world);
    const buys = r.traderEvents.filter(e => e.kind === "buy").length;
    const short = r.shortages.reduce((s, e) => s + e.missing, 0);
    trades += buys;
    segmentTrades += buys;
    shortageUnits += short;
    segmentShortage += short;

    // expireJobs returns events; we count failed expirations + any partial+full
    // via job state changes via expiry events
    for (let _i = 0; _i < r.jobsExpired.length; _i++) {
      jobsExpired += 1;
      segmentJobsExpired += 1;
    }
    // Job completion is implicit (jobs leave world.jobs map). Use trader log
    // for completion count instead — much simpler.

    // Sample-tick metrics
    const traderList = Object.values(world.traders);
    let stuck = 0;
    let broke = 0;
    for (const t of traderList) {
      if (isStuck(world, t)) stuck += 1;
      if (t.funds <= 0.001) broke += 1;
    }
    totalBrokeTickHits += broke;
    totalStuckTickHits += stuck;
    totalTraderTicks += traderList.length;

    if ((i + 1) % SAMPLE_INTERVAL === 0 || i === ticks - 1) {
      const totalFunds = traderList.reduce((s, t) => s + t.funds, 0);
      const totalCargo = totalCargoValue(world);
      const totalTreasury = Object.values(world.markets).reduce((s, m) => s + (m.treasury ?? 0), 0);
      const inTransit = traderList.filter(t => t.state === "transit").length;

      let priceClampHits = 0;
      let priceQuotes = 0;
      let zeroStockHits = 0;
      let stockpileSaturated = 0;
      for (const loc of Object.values(world.locations)) {
        const market = world.markets[loc.id];
        for (const good of Object.values(world.goods)) {
          const target = loc.targetStock[good.id] ?? 0;
          if (target <= 0) continue;
          priceQuotes += 1;
          const price = market.prices[good.id] ?? good.basePrice;
          const stock = market.stock[good.id] ?? 0;
          if (
            price <= good.basePrice * PRICE_FLOOR_MULT + 0.001
            || price >= good.basePrice * PRICE_CEILING_MULT - 0.001
          ) priceClampHits += 1;
          if (stock <= 0.0001) zeroStockHits += 1;
          if (stock >= target * STOCKPILE_CAP_MULT - 0.001) stockpileSaturated += 1;
        }
      }

      peakFunds = Math.max(peakFunds, totalFunds);
      // Skip first 10% of run as warmup for the "min funds" metric
      if (i > ticks * 0.1) minFundsAfterWarmup = Math.min(minFundsAfterWarmup, totalFunds);

      samples.push({
        tick: world.tick,
        totalFunds,
        totalCargoValue: totalCargo,
        totalTreasury,
        totalSystemMoney: totalFunds + totalTreasury,
        stuckTraders: stuck,
        inTransitTraders: inTransit,
        tradesSinceLast: segmentTrades,
        shortageUnitsSinceLast: segmentShortage,
        jobsCompletedSinceLast: segmentJobsCompleted,
        jobsExpiredSinceLast: segmentJobsExpired,
        priceClampHits,
        priceQuotes,
        zeroStockHits,
        stockpileSaturated,
      });
      segmentTrades = 0;
      segmentShortage = 0;
      segmentJobsCompleted = 0;
      segmentJobsExpired = 0;

      // Invariant assertions on the sample tick
      for (const loc of Object.values(world.locations)) {
        const market = world.markets[loc.id];
        for (const good of Object.values(world.goods)) {
          const price = market.prices[good.id] ?? good.basePrice;
          if (price < good.basePrice * PRICE_FLOOR_MULT - 0.01)
            violations.push(`tick ${world.tick}: ${loc.id}/${good.id} price ${price.toFixed(2)} < floor`);
          if (price > good.basePrice * PRICE_CEILING_MULT + 0.01)
            violations.push(`tick ${world.tick}: ${loc.id}/${good.id} price ${price.toFixed(2)} > ceiling`);
          const target = loc.targetStock[good.id] ?? 0;
          if (target > 0 && (market.stock[good.id] ?? 0) < -0.01)
            violations.push(`tick ${world.tick}: ${loc.id}/${good.id} stock negative`);
        }
      }
      for (const t of Object.values(world.traders)) {
        if (t.funds < -0.01) violations.push(`tick ${world.tick}: trader ${t.id} funds ${t.funds.toFixed(2)} < 0`);
      }
    }
  }
  const totalMs = performance.now() - start;

  const finalFunds = Object.values(world.traders).reduce((s, t) => s + t.funds, 0);
  jobsCompleted = sumLogJobsCompleted(world);

  const lastSample = samples[samples.length - 1];
  const priceClampHitFraction = lastSample.priceQuotes > 0 ? lastSample.priceClampHits / lastSample.priceQuotes : 0;
  const zeroStockFraction = lastSample.priceQuotes > 0 ? lastSample.zeroStockHits / lastSample.priceQuotes : 0;
  const stockpileSaturationFraction = lastSample.priceQuotes > 0 ? lastSample.stockpileSaturated / lastSample.priceQuotes : 0;

  // Stock market stats
  const equities = Object.values(world.equities);
  let priceMin = Infinity;
  let priceMax = -Infinity;
  let priceSum = 0;
  let pinnedAtCeiling = 0;
  let pinnedAtFloor = 0;
  for (const eq of equities) {
    const ratio = eq.price / eq.anchorPrice;
    priceMin = Math.min(priceMin, ratio);
    priceMax = Math.max(priceMax, ratio);
    priceSum += ratio;
    if (eq.price >= eq.anchorPrice * SHARE_PRICE_CEILING_MULT - 0.01) pinnedAtCeiling += 1;
    if (eq.price <= eq.anchorPrice * SHARE_PRICE_FLOOR_MULT + 0.01) pinnedAtFloor += 1;
  }
  const equityCount = equities.length;
  const finalEquityPriceStats = {
    min: priceMin === Infinity ? 0 : priceMin,
    max: priceMax === -Infinity ? 0 : priceMax,
    avg: equityCount > 0 ? priceSum / equityCount : 0,
    pinnedAtCeiling,
    pinnedAtFloor,
  };

  return {
    label,
    locations: Object.keys(world.locations).length,
    traders: Object.keys(world.traders).length,
    goods: Object.keys(world.goods).length,
    ticks,
    totalMs,
    msPerTick: totalMs / ticks,
    initialFunds: startFunds,
    finalFunds,
    fundsGrowthRatio: finalFunds / Math.max(1, startFunds),
    peakFunds,
    minFundsAfterWarmup,
    brokeTraderTickFraction: totalBrokeTickHits / Math.max(1, totalTraderTicks),
    stuckTraderTickFraction: totalStuckTickHits / Math.max(1, totalTraderTicks),
    totalTrades: trades,
    tradesPerTickAvg: trades / ticks,
    totalShortageUnits: shortageUnits,
    shortageUnitsPerTickAvg: shortageUnits / ticks,
    jobsCompleted,
    jobsExpired,
    priceClampHitFraction,
    zeroStockFraction,
    stockpileSaturationFraction,
    invariantViolations: violations,
    samples,
    equityCount,
    syndicateCount: Object.keys(world.syndicates).length,
    finalEquityPriceStats,
  };
}

function sumLogJobsCompleted(world: World): number {
  let n = 0;
  for (const t of Object.values(world.traders)) {
    for (const e of t.log ?? []) {
      if (e.kind === "job_completed") n += 1;
    }
  }
  return n;
}

function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function printReport(r: AuditReport): void {
  console.log(`\n━━━ ${r.label} (${r.locations} locs, ${r.traders} traders, ${r.ticks} ticks) ━━━`);
  console.log(`  perf: ${r.msPerTick.toFixed(2)} ms/tick · ${(r.ticks / (r.totalMs / 1000)).toFixed(0)} ticks/sec`);
  console.log(``);
  console.log(`  NPC fleet funds:      Ç${fmtMoney(r.initialFunds)} → Ç${fmtMoney(r.finalFunds)} (${r.fundsGrowthRatio.toFixed(2)}× growth)`);
  console.log(`  peak funds:           Ç${fmtMoney(r.peakFunds)}`);
  console.log(`  min funds (post-warmup): Ç${fmtMoney(r.minFundsAfterWarmup)}`);
  console.log(``);
  console.log(`  trades:               ${r.totalTrades.toLocaleString()} total (${r.tradesPerTickAvg.toFixed(2)}/tick)`);
  console.log(`  shortage units:       ${r.totalShortageUnits.toFixed(0)} total (${r.shortageUnitsPerTickAvg.toFixed(1)}/tick)`);
  console.log(`  jobs completed:       ${r.jobsCompleted}`);
  console.log(`  jobs expired:         ${r.jobsExpired}`);
  console.log(``);
  console.log(`  stuck-trader-ticks:   ${pct(r.stuckTraderTickFraction)} of trader-ticks`);
  console.log(`  broke-trader-ticks:   ${pct(r.brokeTraderTickFraction)} of trader-ticks`);
  console.log(`  price-clamp pinning:  ${pct(r.priceClampHitFraction)} of price quotes`);
  console.log(`  zero-stock quotes:    ${pct(r.zeroStockFraction)} of price quotes`);
  console.log(`  stockpile-saturation: ${pct(r.stockpileSaturationFraction)} of price quotes`);
  if (r.invariantViolations.length > 0) {
    console.log(``);
    console.log(`  ⚠ INVARIANT VIOLATIONS: ${r.invariantViolations.length}`);
    for (const v of r.invariantViolations.slice(0, 6)) console.log(`    ${v}`);
  } else {
    console.log(``);
    console.log(`  invariants OK (price ∈ [0.25×, 5×], funds ≥ 0, stock ≥ 0)`);
  }
  console.log(``);
  console.log(`  stock market:         ${r.equityCount} equities (${r.syndicateCount} syndicates)`);
  console.log(`    price range:        [${r.finalEquityPriceStats.min.toFixed(2)}×, ${r.finalEquityPriceStats.max.toFixed(2)}×] of anchor (avg ${r.finalEquityPriceStats.avg.toFixed(2)}×)`);
  console.log(`    pinned at floor:    ${r.finalEquityPriceStats.pinnedAtFloor} / ${r.equityCount}`);
  console.log(`    pinned at ceiling:  ${r.finalEquityPriceStats.pinnedAtCeiling} / ${r.equityCount}`);

  // Time-series fund growth — read off the samples
  console.log(``);
  console.log(`  time series:    tick   trader_funds   treasury   system_money    trades stuck  shortage`);
  const labelStep = Math.max(1, Math.floor(r.samples.length / 10));
  for (let i = 0; i < r.samples.length; i += labelStep) {
    const s = r.samples[i];
    console.log(`    t=${s.tick.toString().padStart(6)}     Ç${fmtMoney(s.totalFunds).padStart(8)}    Ç${fmtMoney(s.totalTreasury).padStart(8)}    Ç${fmtMoney(s.totalSystemMoney).padStart(8)}     ${s.tradesSinceLast.toString().padStart(4)}  ${s.stuckTraders.toString().padStart(3)}  ${s.shortageUnitsSinceLast.toFixed(0).padStart(5)}`);
  }
}

console.log(`\n=== Long-horizon economy audit ===\nhorizon=${HORIZON}, sample interval=${SAMPLE_INTERVAL}\n`);

const reports: AuditReport[] = [];

// 1) Starter universe (hand-tuned, 4 locations, 6 NPCs). The canonical "is the
// game economy still good after a long session?" test.
{
  const w = createWorld({ player: null });
  reports.push(audit(w, "starter universe (4 loc / 6 NPC)", HORIZON));
}

// 2) Generated 50-location world — the realistic "expanded universe" stress.
{
  const w = generateWorld({ seed: 42, locationCount: 50, player: null });
  reports.push(audit(w, "generated 50-loc (seed=42)", HORIZON));
}

// 3) Generated small world (12 loc) — a mid-tier stress.
{
  const w = generateWorld({ seed: 7, locationCount: 12, player: null });
  reports.push(audit(w, "generated 12-loc (seed=7)", HORIZON));
}

for (const r of reports) printReport(r);

// Summary
console.log(`\n━━━ Summary ━━━`);
for (const r of reports) {
  const status = r.invariantViolations.length === 0 ? "✓" : "⚠";
  console.log(`  ${status} ${r.label.padEnd(40)} growth=${r.fundsGrowthRatio.toFixed(2)}× · clamp=${pct(r.priceClampHitFraction)} · stuck=${pct(r.stuckTraderTickFraction)} · trades/t=${r.tradesPerTickAvg.toFixed(2)}`);
}
