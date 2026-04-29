// Isolated single-trader arrival. The destination market is frozen — no
// production, no consumption, no other traders moving — so the only force
// acting on stock and price is the one ship's cargo dripping in. Lets us
// see the drip+EMA stack on a textbook case.
// Run: `npx tsx src/tools/priceTraceArrival.ts`

import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { priceFor } from "../sim/pricing";
import type { Trader } from "../sim/types";

const TICKS = 25;
const DST = "haven";
const GOOD = "grain";
const CARGO_QTY = 50;

// Build a world stripped of production/consumption at every location, with
// only one trader (in transit, arriving on tick 1) and no others.
const baseWorld = createWorld();

for (const loc of Object.values(baseWorld.locations)) {
  loc.produces = [];
  loc.consumes = [];
}

const dst = baseWorld.locations[DST];
const dstMarket = baseWorld.markets[DST];
dstMarket.stock[GOOD] = dst.targetStock[GOOD] ?? 80;
const target = dst.targetStock[GOOD] ?? 80;
const base = baseWorld.goods[GOOD].basePrice;

const w = createWorld({
  goods: baseWorld.goods,
  locations: baseWorld.locations,
  lanes: baseWorld.lanes,
  traders: {
    arriver: {
      id: "arriver",
      name: "Arriver",
      capacity: 200,
      speed: 1,
      fuelCapacity: 100,
      fuelTypes: [{ good: "plasma", perDistance: 1 }],
      currentFuel: { good: "plasma", qty: 100 },
      funds: 1_000_000,
      location: "verdant",
      destination: DST,
      state: "transit",
      ticksRemaining: 1,
      cargo: [{ good: GOOD, qty: CARGO_QTY, source: "verdant", unitPrice: base, purchasedAt: 0 }],
      pilot: "npc",
      log: [],
    } satisfies Trader,
  },
  player: null,
});
// Make sure the freshly-constructed world's destination market starts at the
// same equilibrium (target stock, base price) the createWorld defaults already
// give us, but be explicit for the trace's sake.
w.markets[DST].stock[GOOD] = target;
w.markets[DST].prices[GOOD] = base;

interface Row {
  tick: number;
  stock: number;
  raw: number;
  smoothed: number;
  cargo: number;
  state: string;
  unloadLeft: number | undefined;
}

const rows: Row[] = [];

for (let t = 0; t <= TICKS; t++) {
  const market = w.markets[DST];
  const ship = w.traders.arriver;
  const stock = market.stock[GOOD] ?? 0;
  rows.push({
    tick: t,
    stock,
    raw: priceFor(base, stock, target),
    smoothed: market.prices[GOOD] ?? base,
    cargo: ship.cargo.reduce((s, l) => s + (l.good === GOOD ? l.qty : 0), 0),
    state: ship.state,
    unloadLeft: ship.unloadTicksRemaining,
  });
  if (t < TICKS) tickWorld(w);
}

const minP = Math.min(...rows.map(r => Math.min(r.raw, r.smoothed)));
const maxP = Math.max(...rows.map(r => Math.max(r.raw, r.smoothed)));
const span = maxP - minP || 1;
const COLS = 50;

function overlay(raw: number, smoothed: number): string {
  const rawCol = Math.round(((raw - minP) / span) * (COLS - 1));
  const smoothCol = Math.round(((smoothed - minP) / span) * (COLS - 1));
  const cells = Array.from({ length: COLS }, () => " ");
  cells[rawCol] = ".";
  cells[smoothCol] = "#";
  if (rawCol === smoothCol) cells[rawCol] = "X";
  return cells.join("");
}

console.log(`\nIsolated trader arrival — ${GOOD} @ ${DST}`);
console.log(`Market frozen (no production/consumption). Single ship carrying ${CARGO_QTY} units.`);
console.log(`Base: ${base.toFixed(2)}    Target: ${target}    Range: ${minP.toFixed(2)} … ${maxP.toFixed(2)}`);
console.log(`.=raw priceFor   #=smoothed market.prices   X=overlap\n`);
console.log(`${"tick".padStart(4)} ${"stock".padStart(6)} ${"cargo".padStart(6)} ${"state".padStart(8)} ${"undrip".padStart(6)} ${"raw".padStart(7)} ${"smooth".padStart(7)}  |${"price scale".padEnd(COLS)}|`);
console.log(`${"".padStart(4)} ${"".padStart(6)} ${"".padStart(6)} ${"".padStart(8)} ${"".padStart(6)} ${"".padStart(7)} ${"".padStart(7)}  |${"-".repeat(COLS)}|`);

for (const r of rows) {
  console.log(
    `${String(r.tick).padStart(4)} ${r.stock.toFixed(1).padStart(6)} ${r.cargo.toFixed(1).padStart(6)} ${r.state.padStart(8)} ${(r.unloadLeft ?? "-").toString().padStart(6)} ${r.raw.toFixed(2).padStart(7)} ${r.smoothed.toFixed(2).padStart(7)}  |${overlay(r.raw, r.smoothed)}|`
  );
}

console.log(`\n. = raw priceFor (would be the displayed price under the OLD instant model)`);
console.log(`# = smoothed market.prices (what the player actually sees now)`);
console.log(`Stock and cargo columns show the drip in action: cargo drains from ${CARGO_QTY} → 0 over the unload window,`);
console.log(`destination stock climbs by the same amount. 'undrip' is unloadTicksRemaining at the start of each tick.`);
