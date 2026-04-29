// Diagnostic: dump the actual order book state for each equity after some
// agent activity. Helps debug "the book doesn't look like a real book"
// reports — shows what the UI panel is actually rendering from.
//
// Run: `npx tsx src/tools/orderBookSnapshot.ts`

import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { listEquities } from "../sim/stock";

const TICKS = Number(process.env.TICKS ?? 50);

const w = createWorld();
for (const t of Object.values(w.traders)) {
  if (t.pilot === "npc") t.funds = Math.max(t.funds, 250_000);
}
for (let i = 0; i < TICKS; i++) tickWorld(w);

console.log(`\nOrder book snapshot after ${TICKS} ticks (default world).\n`);

for (const eq of listEquities(w)) {
  const book = w.orderBooks?.[eq.id];
  console.log(`--- ${eq.ticker} (${eq.kind}) — last price Ç${eq.price.toFixed(2)}, anchor Ç${eq.anchorPrice.toFixed(2)} ---`);
  if (!book) {
    console.log("  (no book)\n");
    continue;
  }
  const bids = book.bids.slice(0, 8);
  const asks = book.asks.slice(0, 8);
  if (bids.length === 0 && asks.length === 0) {
    console.log("  (empty book)\n");
    continue;
  }
  // Conventional DOM layout: asks at top (worst → best descending),
  // spread row, then bids best → worst.
  console.log(`  ${"BIDS".padEnd(28)}  ${"ASKS".padEnd(28)}`);
  console.log(`  ${"price   qty   agent".padEnd(28)}  ${"price   qty   agent".padEnd(28)}`);
  const rows = Math.max(bids.length, asks.length);
  for (let i = 0; i < rows; i++) {
    const b = bids[i];
    const a = asks[i];
    const bs = b ? `${b.limitPrice.toFixed(2).padStart(7)}  ${Math.round(b.qty).toString().padStart(5)}  ${b.agentId.slice(0, 11)}`.padEnd(28) : "".padEnd(28);
    const as = a ? `${a.limitPrice.toFixed(2).padStart(7)}  ${Math.round(a.qty).toString().padStart(5)}  ${a.agentId.slice(0, 11)}`.padEnd(28) : "".padEnd(28);
    console.log(`  ${bs}  ${as}`);
  }
  const bestBid = book.bids[0]?.limitPrice;
  const bestAsk = book.asks[0]?.limitPrice;
  if (bestBid != null && bestAsk != null) {
    const spread = bestAsk - bestBid;
    const pct = (spread / ((bestBid + bestAsk) / 2)) * 100;
    console.log(`  spread: Ç${spread.toFixed(2)} (${pct.toFixed(2)}%)`);
  } else {
    console.log(`  spread: ${bestBid == null ? "no bids" : "no asks"}`);
  }
  console.log();
}
