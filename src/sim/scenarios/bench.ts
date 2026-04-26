import { generateWorld } from "../gen/world";
import { tickN, tickWorld } from "../tick";
import type { World } from "../types";

interface BenchResult {
  locations: number;
  traders: number;
  goods: number;
  ticks: number;
  totalMs: number;
  msPerTick: number;
  ticksPerSec: number;
  shortageUnits: number;
  trades: number;
  fundsTotal: number;
}

function bench(seed: number, locationCount: number, ticks: number, traderMultiplier = 1.5): BenchResult {
  const w = generateWorld({
    seed,
    locationCount,
    traderCount: Math.max(2, Math.round(locationCount * traderMultiplier)),
  });
  const traderCount = Object.keys(w.traders).length;
  const goodCount = Object.keys(w.goods).length;

  tickN(w, 50);
  let shortageUnits = 0;
  let trades = 0;

  const start = performance.now();
  for (let i = 0; i < ticks; i++) {
    const r = tickWorld(w);
    shortageUnits += r.shortages.reduce((s, e) => s + e.missing, 0);
    trades += r.traderEvents.filter(e => e.kind === "buy").length;
  }
  const totalMs = performance.now() - start;

  const fundsTotal = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);

  return {
    locations: locationCount,
    traders: traderCount,
    goods: goodCount,
    ticks,
    totalMs,
    msPerTick: totalMs / ticks,
    ticksPerSec: 1000 / (totalMs / ticks),
    shortageUnits,
    trades,
    fundsTotal,
  };
}

function fmt(n: number, w = 8, d = 2): string {
  return n.toFixed(d).padStart(w);
}

const SIZES = [10, 25, 50, 100, 200, 500, 1000];
const TICKS_PER_RUN = 200;
const SEED = 42;

console.log(`\n=== Scale Benchmark (seed=${SEED}, ${TICKS_PER_RUN} ticks per run) ===\n`);
console.log(
  "locations  traders  goods   ms/tick   ticks/s   total_ms   shortage_units    trades    funds",
);
console.log(
  "─────────  ───────  ─────  ────────  ────────  ─────────  ──────────────  ─────────  ────────",
);

for (const n of SIZES) {
  try {
    const r = bench(SEED, n, TICKS_PER_RUN);
    console.log(
      `${String(r.locations).padStart(9)}  ${String(r.traders).padStart(7)}  ${String(r.goods).padStart(5)}  ` +
      `${fmt(r.msPerTick, 8, 3)}  ${fmt(r.ticksPerSec, 8, 0)}  ${fmt(r.totalMs, 9, 0)}  ` +
      `${fmt(r.shortageUnits, 14, 0)}  ${String(r.trades).padStart(9)}  ${fmt(r.fundsTotal, 8, 0)}`,
    );
  } catch (e) {
    console.log(`${String(n).padStart(9)}  ERROR: ${(e as Error).message}`);
  }
}

console.log("\nNotes:");
console.log("- ms/tick scaling tells us where the next bottleneck is.");
console.log("- evaluateOptions is currently O(traders × goods × locations) per tick.");
console.log("- Linear in traders & goods; quadratic in locations (every trader scans every dest).");
