// Phase 2 verification demo: run a default world for ~200 ticks and report
// agent activity per equity — trade count, side mix, depth, position
// distribution. The success criterion in docs/STOCK_ORDERBOOK.md is
// "100+ trades per equity (real volume) without invariant violations."
//
// Run: `npx tsx src/tools/agentsDemo.ts`

import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { listEquities } from "../sim/stock";
import type { World } from "../sim/types";

const TICKS = 250;

const w = createWorld();

// Boost NPC funds so order sizing isn't floor-rounded to zero across the run.
for (const t of Object.values(w.traders)) {
  if (t.pilot === "npc") t.funds = Math.max(t.funds, 250_000);
}

const start = Date.now();
for (let i = 0; i < TICKS; i++) tickWorld(w);
const elapsedMs = Date.now() - start;

const eqs = listEquities(w);

let totalTrades = 0;
let totalQty = 0;
let totalNotional = 0;

console.log(`\nPhase 2 agent demo: ${TICKS} ticks across ${eqs.length} equities (${elapsedMs}ms).\n`);

const header = `${"ticker".padEnd(6)}  ${"kind".padEnd(10)}  ${"trades".padStart(7)}  ${"qty".padStart(8)}  ${"buys".padStart(6)}  ${"sells".padStart(6)}  ${"price".padStart(8)}  ${"vs IPO".padStart(8)}  ${"depth".padStart(6)}`;
console.log(header);
console.log("-".repeat(header.length));

const rows: string[] = [];
for (const eq of eqs) {
  const trades = eq.recentTrades ?? [];
  const buys = trades.filter(t => t.takerSide === "bid").length;
  const sells = trades.filter(t => t.takerSide === "ask").length;
  const qty = trades.reduce((s, t) => s + t.qty, 0);
  const notional = trades.reduce((s, t) => s + t.qty * t.price, 0);
  totalTrades += trades.length;
  totalQty += qty;
  totalNotional += notional;
  const book = w.orderBooks?.[eq.id];
  const depth = (book?.bids.length ?? 0) + (book?.asks.length ?? 0);
  rows.push(
    `${eq.ticker.padEnd(6)}  ${eq.kind.padEnd(10)}  ` +
    `${trades.length.toString().padStart(7)}  ` +
    `${Math.round(qty).toLocaleString().padStart(8)}  ` +
    `${buys.toString().padStart(6)}  ${sells.toString().padStart(6)}  ` +
    `${eq.price.toFixed(2).padStart(8)}  ` +
    `${(eq.price / eq.anchorPrice).toFixed(2).padStart(7)}x  ` +
    `${depth.toString().padStart(6)}`,
  );
}
rows.sort();
for (const r of rows) console.log(r);

console.log();
console.log(`Total prints: ${totalTrades.toLocaleString()}  ·  qty: ${Math.round(totalQty).toLocaleString()}  ·  notional: Ç${Math.round(totalNotional).toLocaleString()}`);

// Style distribution across NPC ships.
const styleCounts: Record<string, number> = {};
for (const t of Object.values(w.traders)) {
  if (t.pilot !== "npc" || !t.stockState) continue;
  const s = t.stockState.style;
  styleCounts[s] = (styleCounts[s] ?? 0) + 1;
}
console.log(`\nAgent style mix: ${Object.entries(styleCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);

// Float invariant check.
console.log(`\nFloat invariant check (long shares ≤ sharesOutstanding):`);
let violations = 0;
for (const eq of eqs) {
  let longs = 0;
  const pp = (w as World).player?.positions?.[eq.id];
  if (pp?.kind === "long") longs += pp.shares;
  for (const t of Object.values(w.traders)) {
    const ap = t.stockState?.positions[eq.id];
    if (ap && ap.shares > 0) longs += ap.shares;
  }
  if (longs > eq.sharesOutstanding + 1) {
    console.log(`  ! ${eq.ticker}: longs=${longs} > outstanding=${eq.sharesOutstanding}`);
    violations++;
  }
}
console.log(violations === 0 ? "  ✓ All equities respect float invariant." : `  ${violations} violations.`);

// Per-equity success criterion.
const trading = eqs.filter(e => (e.recentTrades?.length ?? 0) >= 100).length;
const total = eqs.length;
console.log(`\nSuccess criterion: ${trading}/${total} equities have ≥100 trades in window. ${trading >= Math.floor(total / 4) ? "✓ pass" : "✗ fail"}`);
