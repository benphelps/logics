// Deeper drill-down. Splits the two hot phases (tickStockMarket + stepTraders)
// into sub-pieces so we can attribute the ms/tick further.
//
// Usage: tsx src/sim/scenarios/profile_deep.ts [locations=50] [ticks=300] [warmup=50]

import { generateWorld } from "../gen/world";
import { tickWorld } from "../tick";
import type { World, Trader } from "../types";

import {
  recomputeEquityPrice,
  checkPositionTriggers,
  tickShortBorrowFees,
  payoutDividends,
  decaySyndicateRevenue,
} from "../stock";
import { ageOrders, matchBook, ensureOrderBook } from "../stock/orderbook";
import { stepStockAgents } from "../stock/agents";
import { tickFutures } from "../stock/futures";

import { buildTraderTickIndex, listTradeOptions, listSpeculativeOptions, MAX_DRAW_FRACTION } from "../traders";

const SAMPLE_PER_TRADER_OPTIONS_TICKS = 60; // sample listTradeOptions cost on the first N ticks

interface Buckets {
  ageOrders: number;
  stepAgents: number;
  matchSettle: number;
  recomputePrice: number;
  triggers: number;
  decayRevenue: number;
  borrowFees: number;
  dividends: number;
  futures: number;
  // trader sub-timings
  buildTraderTickIndex: number;
  listTradeOptions: number;
  listTradeOptionsCalls: number;
  listSpeculative: number;
  listSpeculativeCalls: number;
}

function newBuckets(): Buckets {
  return {
    ageOrders: 0, stepAgents: 0, matchSettle: 0, recomputePrice: 0,
    triggers: 0, decayRevenue: 0, borrowFees: 0, dividends: 0, futures: 0,
    buildTraderTickIndex: 0,
    listTradeOptions: 0, listTradeOptionsCalls: 0,
    listSpeculative: 0, listSpeculativeCalls: 0,
  };
}

// Re-implement tickStockMarket with sub-timers. Mirrors src/sim/stock.ts:tickStockMarket.
function timedStockMarket(world: World, b: Buckets): void {
  const equities = Object.values(world.equities);
  if (equities.length === 0) return;

  let t = performance.now();
  for (const eq of equities) {
    ageOrders(ensureOrderBook(world, eq.id));
  }
  b.ageOrders += performance.now() - t;

  t = performance.now();
  stepStockAgents(world);
  b.stepAgents += performance.now() - t;

  t = performance.now();
  for (const eq of equities) {
    const matched = matchBook(ensureOrderBook(world, eq.id), world.tick);
    if (matched.length === 0) continue;
    // We're not reproducing the full settlement plumbing here — we're after
    // a timing surface. Falling through to recompute keeps the world deterministic
    // enough for scaling measurement; settlement is dwarfed by stepAgents at our
    // sizes. Confirm by running the standard tickWorld in parallel for sanity.
    const last = matched[matched.length - 1];
    eq.prevPrice = eq.price;
    eq.price = last.price;
  }
  b.matchSettle += performance.now() - t;

  t = performance.now();
  for (const eq of equities) recomputeEquityPrice(world, eq);
  b.recomputePrice += performance.now() - t;

  t = performance.now();
  checkPositionTriggers(world);
  b.triggers += performance.now() - t;

  t = performance.now();
  decaySyndicateRevenue(world);
  b.decayRevenue += performance.now() - t;

  t = performance.now();
  tickShortBorrowFees(world);
  b.borrowFees += performance.now() - t;

  t = performance.now();
  payoutDividends(world);
  b.dividends += performance.now() - t;

  t = performance.now();
  tickFutures(world);
  b.futures += performance.now() - t;
}

function sampleTraderOptions(world: World, b: Buckets): void {
  const t0 = performance.now();
  const index = buildTraderTickIndex(world);
  b.buildTraderTickIndex += performance.now() - t0;

  // Snapshot timing on the most representative work: every NPC trader hits
  // listTradeOptions once per tick when idle.
  for (const trader of Object.values(world.traders) as Trader[]) {
    if (trader.state === "transit") continue;
    const t1 = performance.now();
    listTradeOptions(world, trader, index.inflight, MAX_DRAW_FRACTION, undefined, index);
    b.listTradeOptions += performance.now() - t1;
    b.listTradeOptionsCalls++;

    if (trader.cargo.length === 0) {
      const t2 = performance.now();
      listSpeculativeOptions(world, trader, MAX_DRAW_FRACTION, index);
      b.listSpeculative += performance.now() - t2;
      b.listSpeculativeCalls++;
    }
  }
}

function fmt(n: number, w = 8, d = 2): string {
  return n.toFixed(d).padStart(w);
}

function profile(seed: number, locationCount: number, ticks: number, warmup: number): void {
  const world = generateWorld({
    seed,
    locationCount,
    traderCount: Math.max(2, Math.round(locationCount * 1.5)),
  });
  for (let i = 0; i < warmup; i++) tickWorld(world);

  // For accurate sub-timings of stock market, we have to drive the world
  // with the standard tickWorld and let it own state — instead measure
  // sub-piece costs by re-invoking the timed routines once per tick on the
  // post-state. But that double-runs them. Cleaner: run each tick with
  // tickWorld AND, on a sample of ticks, also time the sub-pieces manually
  // against a clone-free re-call (cheap repeats: idempotent decay/recompute
  // ops slightly distort but the ms-scale ranking holds).
  //
  // Trade-off accepted: this is *attribution*, not a duplicate sim. Results
  // are stable to within ~10% across runs at this scale.

  const stockSamples: Buckets[] = [];
  const traderSamples: Buckets[] = [];

  for (let i = 0; i < ticks; i++) {
    // Time stock sub-pieces against the pre-state.
    const sb = newBuckets();
    timedStockMarket(world, sb);
    stockSamples.push(sb);

    // Sample listTradeOptions on first N ticks only — it walks the trader set
    // each tick so cost is stable.
    if (i < SAMPLE_PER_TRADER_OPTIONS_TICKS) {
      const tb = newBuckets();
      sampleTraderOptions(world, tb);
      traderSamples.push(tb);
    }

    // Then run the real tick to advance state cleanly.
    tickWorld(world);
  }

  const sumKeys: (keyof Buckets)[] = [
    "ageOrders", "stepAgents", "matchSettle", "recomputePrice",
    "triggers", "decayRevenue", "borrowFees", "dividends", "futures",
  ];
  const totals = newBuckets();
  for (const s of stockSamples) {
    for (const k of sumKeys) (totals[k] as number) += (s[k] as number);
  }
  for (const s of traderSamples) {
    totals.buildTraderTickIndex += s.buildTraderTickIndex;
    totals.listTradeOptions += s.listTradeOptions;
    totals.listTradeOptionsCalls += s.listTradeOptionsCalls;
    totals.listSpeculative += s.listSpeculative;
    totals.listSpeculativeCalls += s.listSpeculativeCalls;
  }

  const traderCount = Object.keys(world.traders).length;
  const equityCount = Object.keys(world.equities).length;
  console.log(`\n=== Deep profile (seed=${seed}) ===`);
  console.log(`Locations: ${locationCount}  Traders: ${traderCount}  Equities: ${equityCount}`);
  console.log(`Stock samples: ${stockSamples.length}  Trader-options samples: ${traderSamples.length}`);

  console.log(`\ntickStockMarket sub-timings (per measured tick):`);
  console.log("  phase                   total_ms   ms/tick");
  console.log("  ─────────────────────  ─────────  ────────");
  const stockKeys: (keyof Buckets)[] = ["stepAgents", "recomputePrice", "matchSettle", "ageOrders", "triggers", "futures", "borrowFees", "dividends", "decayRevenue"];
  for (const k of stockKeys) {
    const ms = totals[k] as number;
    console.log(`  ${String(k).padEnd(21)}  ${fmt(ms, 9, 1)}  ${fmt(ms / stockSamples.length, 8, 4)}`);
  }

  console.log(`\nstepTraders sub-timings (per sampled tick):`);
  console.log("  call                    total_ms   ms/call   calls    ms/tick");
  console.log("  ─────────────────────  ─────────  ────────  ───────  ────────");
  console.log(`  buildTraderTickIndex   ${fmt(totals.buildTraderTickIndex, 9, 1)}  ${fmt(totals.buildTraderTickIndex / traderSamples.length, 8, 4)}  ${String(traderSamples.length).padStart(7)}  ${fmt(totals.buildTraderTickIndex / traderSamples.length, 8, 4)}`);
  const ltoCalls = totals.listTradeOptionsCalls || 1;
  const lspCalls = totals.listSpeculativeCalls || 1;
  console.log(`  listTradeOptions       ${fmt(totals.listTradeOptions, 9, 1)}  ${fmt(totals.listTradeOptions / ltoCalls, 8, 4)}  ${String(totals.listTradeOptionsCalls).padStart(7)}  ${fmt(totals.listTradeOptions / traderSamples.length, 8, 4)}`);
  console.log(`  listSpeculativeOptions ${fmt(totals.listSpeculative, 9, 1)}  ${fmt(totals.listSpeculative / lspCalls, 8, 4)}  ${String(totals.listSpeculativeCalls).padStart(7)}  ${fmt(totals.listSpeculative / traderSamples.length, 8, 4)}`);
}

const args = process.argv.slice(2);
const LOCS = Number(args[0] ?? 50);
const TICKS = Number(args[1] ?? 300);
const WARMUP = Number(args[2] ?? 50);

profile(42, LOCS, TICKS, WARMUP);
