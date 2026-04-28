// Per-tick money flow tracer. Confirms the closed-loop accounting holds — if
// total system money drifts in a way that doesn't match (replenish - maint),
// there's a leak somewhere.

import { createWorld } from "../world";
import { tickWorld } from "../tick";

const w = createWorld({ player: null });

function totalSystemMoney(): { traderFunds: number; treasury: number; total: number } {
  const traderFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
  const treasury = Object.values(w.markets).reduce((s, m) => s + (m.treasury ?? 0), 0);
  return { traderFunds, treasury, total: traderFunds + treasury };
}

let prev = totalSystemMoney();
console.log(`tick    traderFunds  treasury    total      delta`);
console.log(`${(0).toString().padStart(4)}    ${prev.traderFunds.toFixed(0).padStart(8)}    ${prev.treasury.toFixed(0).padStart(8)}    ${prev.total.toFixed(0).padStart(9)}    -`);

const TICKS = 200;
for (let i = 0; i < TICKS; i++) {
  tickWorld(w);
  const cur = totalSystemMoney();
  const delta = cur.total - prev.total;
  if (i < 20 || i % 20 === 0 || i === TICKS - 1) {
    console.log(`${(i + 1).toString().padStart(4)}    ${cur.traderFunds.toFixed(0).padStart(8)}    ${cur.treasury.toFixed(0).padStart(8)}    ${cur.total.toFixed(0).padStart(9)}    ${delta.toFixed(1).padStart(8)}`);
  }
  prev = cur;
}

console.log(`\nFinal trader breakdown:`);
for (const t of Object.values(w.traders)) {
  console.log(`  ${t.name.padEnd(15)} funds=${t.funds.toFixed(0).padStart(8)}  state=${t.state}  loc=${t.location}`);
}
console.log(`\nFinal treasuries:`);
for (const loc of Object.values(w.locations)) {
  const m = w.markets[loc.id];
  console.log(`  ${loc.name.padEnd(15)} treasury=${m.treasury?.toFixed(0).padStart(8)}  target=${m.treasuryTarget?.toFixed(0).padStart(8)}`);
}
