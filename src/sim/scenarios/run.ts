import { createWorld } from "../world";
import { tickN } from "../tick";
import type { World } from "../types";

const TICKS = Number(process.argv[2] ?? 100);

function fmtMarkets(w: World): string {
  const goodIds = Object.keys(w.goods);
  const header = "Location".padEnd(15) + goodIds.map(g => g.padStart(11)).join("");
  const rows = Object.values(w.locations).map(loc => {
    const m = w.markets[loc.id];
    const cells = goodIds.map(g => `${m.stock[g].toFixed(0).padStart(4)}@${m.prices[g].toFixed(1).padStart(5)}`);
    return loc.name.padEnd(15) + cells.map(c => c.padStart(11)).join("");
  });
  return [header, ...rows].join("\n");
}

function fmtTraders(w: World): string {
  return Object.values(w.traders).map(t => {
    const cargo = t.cargo.length === 0 ? "—" : t.cargo.map(l => `${l.good}x${l.qty}`).join("+");
    const dest = t.destination ?? "—";
    return `  ${t.name.padEnd(15)} @${t.location.padEnd(11)} ${t.state.padEnd(7)} ⮕ ${dest.padEnd(11)} cargo=${cargo.padEnd(14)} funds=${t.funds.toFixed(0)}`;
  }).join("\n");
}

const w = createWorld();
const reports = tickN(w, TICKS);

console.log(`\n=== After ${TICKS} ticks ===\n`);
console.log(fmtMarkets(w));
console.log("\nTraders:");
console.log(fmtTraders(w));

const allShortages = reports.flatMap(r => r.shortages);
const byKey = new Map<string, number>();
for (const s of allShortages) {
  const k = `${s.location}/${s.good}`;
  byKey.set(k, (byKey.get(k) ?? 0) + s.missing);
}
const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

console.log(`\nTotal shortage units missed: ${allShortages.reduce((s, e) => s + e.missing, 0).toFixed(1)}`);
console.log("Worst recurring shortages:");
for (const [k, v] of top) console.log(`  ${k.padEnd(28)} ${v.toFixed(1)} units missed total`);

const tradeCount = reports.flatMap(r => r.traderEvents).filter(e => e.kind === "buy").length;
console.log(`\nCompleted trades: ${tradeCount}`);
