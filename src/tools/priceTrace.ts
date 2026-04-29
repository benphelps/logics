// One-off scope: trace one good's price at one station across ticks, with
// two artificial shocks injected, so we can eyeball the EMA's response next
// to the raw-elasticity reference. Run: `npx tsx src/tools/priceTrace.ts`.

import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { priceFor } from "../sim/pricing";

const TICKS = 80;
const SHOCK_DRAIN_AT = 20;   // crash stock low — price target should spike
const SHOCK_FLOOD_AT = 50;   // dump stock high — price target should drop
const LOC = "haven";
const GOOD = "grain";

const w = createWorld();
const loc = w.locations[LOC];
const market = w.markets[LOC];
const base = w.goods[GOOD].basePrice;
const target = loc.targetStock[GOOD] ?? 0;

interface Row {
  tick: number;
  stock: number;
  raw: number;       // what priceFor returns from current stock — the EMA target
  smoothed: number;  // what market.prices stores — what the player sees
  note?: string;
}

const rows: Row[] = [];

for (let t = 0; t <= TICKS; t++) {
  if (t === SHOCK_DRAIN_AT) {
    market.stock[GOOD] = target * 0.1;
  }
  if (t === SHOCK_FLOOD_AT) {
    market.stock[GOOD] = target * 2.5;
  }

  const stock = market.stock[GOOD] ?? 0;
  const raw = priceFor(base, stock, target);
  const smoothed = market.prices[GOOD] ?? base;
  const note = t === SHOCK_DRAIN_AT ? "← drain to 10% of target"
    : t === SHOCK_FLOOD_AT ? "← flood to 250% of target"
    : undefined;
  rows.push({ tick: t, stock, raw, smoothed, note });

  if (t < TICKS) tickWorld(w);
}

const minP = Math.min(base * 0.5, ...rows.map(r => Math.min(r.raw, r.smoothed)));
const maxP = Math.max(base * 1.5, ...rows.map(r => Math.max(r.raw, r.smoothed)));
const span = maxP - minP || 1;
const COLS = 50;

function bar(p: number, marker: string): string {
  const col = Math.round(((p - minP) / span) * (COLS - 1));
  return " ".repeat(col) + marker;
}

function overlay(raw: number, smoothed: number): string {
  const rawCol = Math.round(((raw - minP) / span) * (COLS - 1));
  const smoothCol = Math.round(((smoothed - minP) / span) * (COLS - 1));
  const cells = Array.from({ length: COLS }, () => " ");
  cells[rawCol] = ".";       // raw (would-be instant) target
  cells[smoothCol] = "#";    // smoothed (actual displayed) price
  if (rawCol === smoothCol) cells[rawCol] = "X";
  return cells.join("");
}

console.log(`\nStation: ${LOC}    Good: ${GOOD}    Base: ${base.toFixed(2)}    Target stock: ${target}`);
console.log(`Range plotted: ${minP.toFixed(2)} … ${maxP.toFixed(2)}    .=raw priceFor   #=smoothed market.prices   X=overlap\n`);
console.log(`${"tick".padStart(4)} ${"stock".padStart(7)} ${"raw".padStart(7)} ${"smooth".padStart(7)}  |${"price scale".padEnd(COLS)}|  note`);
console.log(`${"".padStart(4)} ${"".padStart(7)} ${"".padStart(7)} ${"".padStart(7)}  |${"-".repeat(COLS)}|`);

for (const r of rows) {
  const line = `${String(r.tick).padStart(4)} ${r.stock.toFixed(1).padStart(7)} ${r.raw.toFixed(2).padStart(7)} ${r.smoothed.toFixed(2).padStart(7)}  |${overlay(r.raw, r.smoothed)}|  ${r.note ?? ""}`;
  console.log(line);
}

console.log();
console.log(`Notes:
- '.' marks the raw priceFor result — what the price WOULD be in the old instant model.
- '#' marks the EMA-smoothed market.prices — what players actually see.
- After a shock, '.' jumps immediately, '#' chases it gradually over many ticks.
- During quiet periods (no shocks), production/consumption shift stock by small amounts each tick;
  raw price tracks those linearly, smoothed price moves even more gently.
`);
void bar;
