// Phase 1 sanity demo: show that a player buy now produces real price impact
// against the synthetic market-maker. Compares two parallel worlds — one
// where the player buys nothing, one where the player buys 5,000 shares of
// a syndicate equity at tick 5 — and traces both equity prices for 30 ticks.
//
// Run: `npx tsx src/tools/stockBookDemo.ts`

import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { listEquities, buyShares } from "../sim/stock";

const TICKS_BEFORE_BUY = 5;
const TICKS_AFTER_BUY = 25;
const BUY_SHARES = 1000;

function runWorld(buy: boolean): { tick: number; price: number }[] {
  const w = createWorld();
  // Pick a station equity. Station fundamentals scale linearly with treasury
  // ratio (no wealth-multiplier cliff), so price moves stay readable.
  const eq = listEquities(w).find(e => e.kind === "station")!;
  const ship = w.traders[w.player!.shipIds[0]];
  ship.funds = 5_000_000;

  const trace: { tick: number; price: number }[] = [];
  trace.push({ tick: 0, price: eq.price });
  for (let i = 0; i < TICKS_BEFORE_BUY; i++) {
    tickWorld(w);
    trace.push({ tick: w.tick, price: eq.price });
  }
  if (buy) {
    const r = buyShares(w, eq.id, BUY_SHARES);
    if (!r.ok) {
      console.error("buy failed:", r.reason);
      process.exit(1);
    }
  }
  trace.push({ tick: w.tick, price: eq.price });
  for (let i = 0; i < TICKS_AFTER_BUY; i++) {
    tickWorld(w);
    trace.push({ tick: w.tick, price: eq.price });
  }
  return trace;
}

const baseline = runWorld(false);
const withBuy = runWorld(true);

console.log(`\nPhase 1 price impact demo: ${BUY_SHARES.toLocaleString()}-share buy of a station equity at tick ${TICKS_BEFORE_BUY}`);
console.log(`Baseline (no trade) vs. With Buy — both worlds use seed=default.\n`);

const header = `${"tick".padStart(4)}  ${"baseline".padStart(10)}  ${"withBuy".padStart(10)}  ${"delta".padStart(8)}  ${"event".padEnd(20)}`;
console.log(header);
console.log("-".repeat(header.length));

const len = Math.max(baseline.length, withBuy.length);
for (let i = 0; i < len; i++) {
  const b = baseline[i];
  const wb = withBuy[i];
  const delta = b && wb ? wb.price - b.price : 0;
  const event = i === TICKS_BEFORE_BUY + 1 ? "← buy 5,000 shares" : "";
  console.log(
    `${String(b?.tick ?? "").padStart(4)}  ` +
    `${(b?.price ?? 0).toFixed(2).padStart(10)}  ` +
    `${(wb?.price ?? 0).toFixed(2).padStart(10)}  ` +
    `${delta >= 0 ? "+" : ""}${delta.toFixed(2).padStart(7)}  ` +
    `${event.padEnd(20)}`,
  );
}

const buyTickIdx = TICKS_BEFORE_BUY + 1;
const beforeBuy = withBuy[TICKS_BEFORE_BUY].price;
const afterBuy = withBuy[buyTickIdx].price;
const impactPct = ((afterBuy - beforeBuy) / beforeBuy) * 100;
const finalDelta = withBuy.at(-1)!.price - baseline.at(-1)!.price;

console.log();
console.log(`Immediate impact:   ${beforeBuy.toFixed(2)} → ${afterBuy.toFixed(2)}  (${impactPct >= 0 ? "+" : ""}${impactPct.toFixed(2)}%)`);
console.log(`After ${TICKS_AFTER_BUY} ticks:    delta vs baseline = ${finalDelta >= 0 ? "+" : ""}${finalDelta.toFixed(2)}`);
console.log();
console.log(`The buy fills at the MM's ask (~+2% over the prior price) and eq.price snaps`);
console.log(`to the fill. The station treasury also gets richer from the buy proceeds, which`);
console.log(`raises the fundamental for subsequent ticks — so the EMA pulls the price up`);
console.log(`further over time. Without the trade, the baseline drifts purely on noise + EMA`);
console.log(`toward fair value.`);
