// Long-horizon stock-market stress diagnostic.
//
// Run: `npx tsx src/tools/stockLongRun.ts [TICKS=20000] [SEED=1] [LOCS=12]`
//
// Probes:
//   * float invariant (long shares ≤ outstanding) every snapshot
//   * money invariant (sum of player.funds + agent stockWallets +
//     equity-underlying treasuries) — should drop monotonically by exactly
//     the broker-fee burn (the only sink in the system)
//   * price clamp violations (must stay in [0.1×, 10×] anchor)
//   * price-pin saturation (how often each equity sits at the floor or
//     ceiling — symptom of broken fundamentals or runaway agent feedback)
//   * agent bankruptcy rate (how many agents have ever fallen below the
//     liquidation threshold; sticky)
//   * volume distribution across equities
//   * book health: avg depth and one-sided-tick fraction
//
// Output is a markdown-flavored summary so it can be pasted into a report.

import { generateWorld } from "../sim/gen/world";
import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { listEquities } from "../sim/stock";
import type { World, Equity } from "../sim/types";

const TICKS = Number(process.argv[2] ?? process.env.TICKS ?? 20_000);
const SEED = Number(process.argv[3] ?? process.env.SEED ?? 1);
const LOCS = Number(process.argv[4] ?? process.env.LOCS ?? 12);
const SNAPSHOT_EVERY = Math.max(1, Math.round(TICKS / 20));
const USE_DEFAULT_WORLD = process.env.WORLD === "default";

interface Snapshot {
  tick: number;
  totalCash: number;       // ship.funds + sum(stockWallet) + sum(treasury) [station + syndicate]
  brokerFeeCum: number;    // running total of fees inferred from prior delta
  agentBankruptCount: number;
  pinnedFloorCount: number;
  pinnedCeilingCount: number;
  oneSidedBooks: number;
  totalOpenOrders: number;
  totalLiveTrades: number;
  perEquityTradeCount: Record<string, number>;
}

function totalSystemCash(world: World): number {
  let total = 0;
  for (const t of Object.values(world.traders)) {
    total += t.funds;
    if (t.stockState) total += t.stockState.stockWallet;
  }
  total += world.player ? (world.player.shipIds[0] ? world.traders[world.player.shipIds[0]]?.funds ?? 0 : 0) - 0 : 0;
  // Note: world.player.shipIds[0] is in world.traders so already counted; don't double.
  for (const m of Object.values(world.markets)) total += m.treasury;
  for (const s of Object.values(world.syndicates)) total += s.treasury;
  return total;
}

function pinnedFloor(eq: Equity): boolean {
  return eq.price <= eq.anchorPrice * 0.1 + 0.01;
}
function pinnedCeiling(eq: Equity): boolean {
  return eq.price >= eq.anchorPrice * 10 - 0.01;
}

function snapshot(world: World): Snapshot {
  const eqs = listEquities(world);
  const perEquityTradeCount: Record<string, number> = {};
  let pinnedFloorCount = 0;
  let pinnedCeilingCount = 0;
  let oneSidedBooks = 0;
  let totalOpenOrders = 0;
  let totalLiveTrades = 0;
  for (const eq of eqs) {
    perEquityTradeCount[eq.ticker] = eq.recentTrades?.length ?? 0;
    totalLiveTrades += eq.recentTrades?.length ?? 0;
    if (pinnedFloor(eq)) pinnedFloorCount++;
    if (pinnedCeiling(eq)) pinnedCeilingCount++;
    const book = world.orderBooks?.[eq.id];
    const bids = book?.bids.length ?? 0;
    const asks = book?.asks.length ?? 0;
    totalOpenOrders += bids + asks;
    if ((bids === 0) !== (asks === 0)) oneSidedBooks++; // one side empty, the other not
    if (bids === 0 && asks === 0) oneSidedBooks++; // entirely empty also counts as broken
  }
  let agentBankruptCount = 0;
  for (const t of Object.values(world.traders)) {
    if (t.pilot !== "npc") continue;
    if (t.stockState && t.stockState.stockWallet < 10_000) agentBankruptCount++;
  }
  return {
    tick: world.tick,
    totalCash: totalSystemCash(world),
    brokerFeeCum: 0,
    agentBankruptCount,
    pinnedFloorCount,
    pinnedCeilingCount,
    oneSidedBooks,
    totalOpenOrders,
    totalLiveTrades,
    perEquityTradeCount,
  };
}

function checkFloatInvariant(world: World): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const eq of Object.values(world.equities)) {
    let longShares = 0;
    let shortShares = 0;
    const pp = world.player?.positions?.[eq.id];
    if (pp?.kind === "long") longShares += pp.shares;
    if (pp?.kind === "short") shortShares += pp.shares;
    for (const t of Object.values(world.traders)) {
      const ap = t.stockState?.positions[eq.id];
      if (ap?.shares != null && ap.shares > 0) longShares += ap.shares;
      if (ap?.shares != null && ap.shares < 0) shortShares += -ap.shares;
    }
    if (longShares > eq.sharesOutstanding + 1) {
      violations.push(`${eq.ticker}: longs=${longShares} > outstanding=${eq.sharesOutstanding}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function checkPriceClamp(world: World): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const eq of Object.values(world.equities)) {
    const lo = eq.anchorPrice * 0.1 - 0.01;
    const hi = eq.anchorPrice * 10 + 0.01;
    if (eq.price < lo || eq.price > hi) {
      violations.push(`${eq.ticker}: price=${eq.price.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
    }
  }
  return { ok: violations.length === 0, violations };
}

const w = USE_DEFAULT_WORLD
  ? createWorld()
  : generateWorld({ seed: SEED, locationCount: LOCS, player: process.env.PLAYER === "1" ? undefined : null });
// Boost NPC funds so order sizing isn't degenerate.
for (const t of Object.values(w.traders)) {
  if (t.pilot === "npc") t.funds = Math.max(t.funds, 250_000);
}

const npcs = Object.values(w.traders).filter(t => t.pilot === "npc").length;
const eqs = listEquities(w);

console.log(`# Stock Market Long-Run Stress Test`);
console.log(``);
console.log(`- Seed: ${SEED}, locations: ${LOCS}, ticks: ${TICKS.toLocaleString()}`);
console.log(`- NPC traders (= stock-trading agents): ${npcs}`);
console.log(`- Equities listed: ${eqs.length} (${eqs.filter(e => e.kind === "station").length} station, ${eqs.filter(e => e.kind === "syndicate").length} syndicate)`);
console.log(``);

const initialCash = totalSystemCash(w);
const initialAgentWallet = Object.values(w.traders).reduce((s, t) => s + (t.stockState?.stockWallet ?? 0), 0);

console.log(`- Initial system cash (ship funds + agent stockWallets + treasuries): Ç${Math.round(initialCash).toLocaleString()}`);
console.log(`- Initial agent stockWallet pool: Ç${Math.round(initialAgentWallet).toLocaleString()}`);
console.log(``);

// Snapshot timeline.
const snaps: Snapshot[] = [];
const start = Date.now();

snaps.push(snapshot(w));

let firstFloatViolationTick: number | null = null;
let firstClampViolationTick: number | null = null;

let prevCash = initialCash;

// Pinned-tick tally across the entire run (one increment per equity per
// tick spent at floor/ceiling). Sampled every tick (not just snapshots).
const pinnedTickTally: Record<string, { floor: number; ceiling: number; min: number; max: number }> = {};
for (const eq of eqs) pinnedTickTally[eq.id] = { floor: 0, ceiling: 0, min: eq.price, max: eq.price };

// Cumulative trade volume tracking — instrument matchBook + executeMarketOrder
// is non-trivial without changing the source. Instead read recentTrades each
// tick and accumulate the *new* trades by id-pair (qty, tick, buyer, seller).
// The recentTrades window caps at 100, so if we read each tick we never miss.
const cumTrades: Record<string, { count: number; qty: number; notional: number; agentVsAgent: number; playerInvolved: number; selfMatched: number; uniqueAgents: Set<string> }> = {};
for (const eq of eqs) cumTrades[eq.id] = { count: 0, qty: 0, notional: 0, agentVsAgent: 0, playerInvolved: 0, selfMatched: 0, uniqueAgents: new Set() };

// Track most recent observed tick per equity to know what's new.
const lastObservedTickPerEq: Record<string, number> = {};
for (const eq of eqs) lastObservedTickPerEq[eq.id] = -1;

const playerShipIds = new Set(w.player?.shipIds ?? []);

for (let i = 1; i <= TICKS; i++) {
  tickWorld(w);

  // Tally trades per tick by reading the recentTrades window for any new
  // entries. The window updates ASAP and caps at 100, so as long as no
  // single equity prints >100 trades in one tick (in practice ≤ a handful),
  // we never miss any.
  for (const eq of eqs) {
    const trades = eq.recentTrades ?? [];
    for (const t of trades) {
      if (t.tick <= lastObservedTickPerEq[eq.id]) continue;
      // New trade.
      const c = cumTrades[eq.id];
      c.count++;
      c.qty += t.qty;
      c.notional += t.qty * t.price;
      const playerSide = playerShipIds.has(t.buyer as string) || playerShipIds.has(t.seller as string);
      if (playerSide) c.playerInvolved++;
      else c.agentVsAgent++;
      if (t.buyer === t.seller) c.selfMatched++;
      c.uniqueAgents.add(t.buyer as string);
      c.uniqueAgents.add(t.seller as string);
    }
    if (trades.length > 0) {
      lastObservedTickPerEq[eq.id] = trades[trades.length - 1].tick;
    }
  }

  // Per-tick pin tally.
  for (const eq of eqs) {
    const t = pinnedTickTally[eq.id];
    if (eq.price < t.min) t.min = eq.price;
    if (eq.price > t.max) t.max = eq.price;
    if (pinnedFloor(eq)) t.floor++;
    if (pinnedCeiling(eq)) t.ceiling++;
  }

  if (i % SNAPSHOT_EVERY === 0 || i === TICKS) {
    const fi = checkFloatInvariant(w);
    if (!fi.ok && firstFloatViolationTick == null) {
      firstFloatViolationTick = w.tick;
    }
    const ci = checkPriceClamp(w);
    if (!ci.ok && firstClampViolationTick == null) {
      firstClampViolationTick = w.tick;
    }
    const cur = totalSystemCash(w);
    prevCash = cur;
    snaps.push(snapshot(w));
  }
}

const elapsedMs = Date.now() - start;
const finalCash = totalSystemCash(w);

console.log(`Run finished in ${elapsedMs}ms (${(TICKS / (elapsedMs / 1000)).toFixed(0)} ticks/sec).`);
console.log(``);

// --- Summaries -----------------------------------------------------------

console.log(`## Invariants`);
console.log(``);
const finalFloat = checkFloatInvariant(w);
const finalClamp = checkPriceClamp(w);
console.log(`- Final float invariant (long ≤ outstanding): ${finalFloat.ok ? "✓ OK" : "✗ FAIL"}`);
if (!finalFloat.ok) for (const v of finalFloat.violations) console.log(`    - ${v}`);
console.log(`- Final price clamp (within [0.1×, 10×] anchor): ${finalClamp.ok ? "✓ OK" : "✗ FAIL"}`);
if (!finalClamp.ok) for (const v of finalClamp.violations) console.log(`    - ${v}`);
console.log(`- First float violation tick: ${firstFloatViolationTick ?? "—"}`);
console.log(`- First clamp violation tick: ${firstClampViolationTick ?? "—"}`);
console.log(``);

console.log(`## System cash`);
console.log(``);
console.log(`- Initial system cash: Ç${Math.round(initialCash).toLocaleString()}`);
console.log(`- Final system cash:   Ç${Math.round(finalCash).toLocaleString()}`);
console.log(`- Net delta:           Ç${Math.round(finalCash - initialCash).toLocaleString()}  (positive ≈ treasury restock; negative ≈ broker burn)`);
console.log(``);

// --- Equity table --------------------------------------------------------

console.log(`## Equity state at tick ${TICKS}`);
console.log(``);
console.log(`| ticker | kind | price | x IPO | min/max x | depth(b/a) | cum trades | cum qty | A↔A% | P% | self-trade |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);

const sortedEqs = listEquities(w);
for (const eq of sortedEqs) {
  const book = w.orderBooks?.[eq.id];
  const bids = book?.bids.length ?? 0;
  const asks = book?.asks.length ?? 0;
  const tally = pinnedTickTally[eq.id];
  const cum = cumTrades[eq.id];
  const aaPct = cum.count === 0 ? 0 : (cum.agentVsAgent / cum.count) * 100;
  const pPct = cum.count === 0 ? 0 : (cum.playerInvolved / cum.count) * 100;
  console.log(
    `| ${eq.ticker} | ${eq.kind} | Ç${eq.price.toFixed(2)} | ${(eq.price / eq.anchorPrice).toFixed(2)}× | ${(tally.min / eq.anchorPrice).toFixed(2)}/${(tally.max / eq.anchorPrice).toFixed(2)}× | ${bids}/${asks} | ${cum.count} | ${Math.round(cum.qty)} | ${aaPct.toFixed(0)} | ${pPct.toFixed(0)} | ${cum.selfMatched} |`,
  );
}
console.log(``);

// --- Pinned saturation across the run (per-tick) ------------------------

let pinnedFloorTickTotal = 0;
let pinnedCeilingTickTotal = 0;
const totalEquityTicks = TICKS * eqs.length;
for (const eq of eqs) {
  pinnedFloorTickTotal += pinnedTickTally[eq.id].floor;
  pinnedCeilingTickTotal += pinnedTickTally[eq.id].ceiling;
}
const floorPct = (pinnedFloorTickTotal / totalEquityTicks) * 100;
const ceilingPct = (pinnedCeilingTickTotal / totalEquityTicks) * 100;

console.log(`## Price-clamp saturation (per-tick over full run)`);
console.log(``);
console.log(`- Equity-ticks pinned at floor:   ${pinnedFloorTickTotal.toLocaleString()}/${totalEquityTicks.toLocaleString()} (${floorPct.toFixed(2)}%)`);
console.log(`- Equity-ticks pinned at ceiling: ${pinnedCeilingTickTotal.toLocaleString()}/${totalEquityTicks.toLocaleString()} (${ceilingPct.toFixed(2)}%)`);
console.log(``);

// --- Trade summary -------------------------------------------------------
let totalTradeCount = 0, totalTradeQty = 0, totalNotional = 0, totalAA = 0, totalPlayer = 0, totalSelf = 0;
for (const eq of eqs) {
  const c = cumTrades[eq.id];
  totalTradeCount += c.count;
  totalTradeQty += c.qty;
  totalNotional += c.notional;
  totalAA += c.agentVsAgent;
  totalPlayer += c.playerInvolved;
  totalSelf += c.selfMatched;
}
console.log(`## Trade summary`);
console.log(``);
console.log(`- Cumulative trades: ${totalTradeCount.toLocaleString()}`);
console.log(`- Cumulative quantity: ${Math.round(totalTradeQty).toLocaleString()}`);
console.log(`- Cumulative notional: Ç${Math.round(totalNotional).toLocaleString()}`);
console.log(`- Trades per equity per 1000 ticks (avg): ${(totalTradeCount / eqs.length / (TICKS / 1000)).toFixed(0)}`);
console.log(`- Agent ↔ agent: ${totalAA.toLocaleString()} (${((totalAA / Math.max(1, totalTradeCount)) * 100).toFixed(1)}%)`);
console.log(`- Player involved: ${totalPlayer.toLocaleString()} (${((totalPlayer / Math.max(1, totalTradeCount)) * 100).toFixed(1)}%)`);
console.log(`- Self-matched (anomaly): ${totalSelf}`);
console.log(``);

// --- Book health ---------------------------------------------------------

const oneSidedFraction = snaps.reduce((s, x) => s + x.oneSidedBooks, 0) / (snaps.length * eqs.length);
const avgOpenOrders = snaps.reduce((s, x) => s + x.totalOpenOrders, 0) / snaps.length;
console.log(`## Book health`);
console.log(``);
console.log(`- Average open orders across all books: ${avgOpenOrders.toFixed(0)}`);
console.log(`- Equity-snapshots with empty/one-sided book: ${(oneSidedFraction * 100).toFixed(1)}%`);
console.log(``);

// --- Bankruptcy ----------------------------------------------------------

const finalBankrupt = snaps[snaps.length - 1].agentBankruptCount;
const peakBankrupt = Math.max(...snaps.map(s => s.agentBankruptCount));
const initialBankrupt = snaps[0].agentBankruptCount;
console.log(`## Agent bankruptcy`);
console.log(``);
console.log(`- Initial bankrupt agents: ${initialBankrupt}/${npcs}`);
console.log(`- Peak bankrupt agents:    ${peakBankrupt}/${npcs}`);
console.log(`- Final bankrupt agents:   ${finalBankrupt}/${npcs}`);
console.log(``);

// --- Snapshot timeline ---------------------------------------------------

console.log(`## Timeline (sampled every ${SNAPSHOT_EVERY} ticks)`);
console.log(``);
console.log(`| tick | sys cash | bankrupt | floor pin | ceil pin | one-sided | open orders | window trades |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const s of snaps) {
  console.log(
    `| ${s.tick} | Ç${Math.round(s.totalCash).toLocaleString()} | ${s.agentBankruptCount} | ${s.pinnedFloorCount} | ${s.pinnedCeilingCount} | ${s.oneSidedBooks} | ${s.totalOpenOrders} | ${s.totalLiveTrades} |`,
  );
}
