// Progression audit. Drives a player ship under "good play" assumptions
// (autopilot suggestion engine, hires when affordable, buys upgrades with
// surplus cash) and records WHEN each upgrade and each crew tier first
// becomes affordable / reachable / actually purchased.
//
// Output: a sorted timeline of unlocks across N seeds, plus aggregates for
// gameplay tuning ("does this price gate the player too long?").
//
// Usage:
//   npm run audit:progression                 # default 6000 ticks, 5 seeds
//   npm run audit:progression -- 12000        # override horizon
//   npm run audit:progression -- 8000 11      # horizon + seed count

import { createWorld } from "../world";
import { generateWorld } from "../gen/world";
import { tickWorld } from "../tick";
import { hireCrew, hasCrew, recomputeShipStats } from "../crew";
import {
  installUpgradeFromMarket,
  repairShip,
} from "../traders";
import { makePlayer } from "../data/player";
import { SHIP_UPGRADES, upgradeEffectText, type ShipUpgradeDef } from "../upgrades";
import type { CrewMember, GoodId, Trader, World } from "../types";
import { writeReports } from "./progression_report";
import { join } from "path";

const HORIZON = Number(process.argv[2] ?? 8000);
const SEED_COUNT = Number(process.argv[3] ?? 5);

// "Synthetic" captain we slot onto the audit's player ship so the autopilot
// runs from tick 0. Without this, pilot=auto without a real captain idles —
// so we couldn't observe the wealth curve at all. The audit still records
// real captain hire offers separately.
const AUDIT_CAPTAIN: CrewMember = {
  id: "audit_synthetic_captain",
  role: "captain",
  name: "(audit autopilot)",
  tier: 1,
  hireCost: 0,
  wagePerTick: 0,
  modifiers: {},
  sex: "male",
  age: "adult",
  race: "human",
};

// Working capital reserve — the player won't drain to zero on upgrades.
// Bigger ships need more ballast; smaller ships need less.
const UPGRADE_RESERVE_FUNDS = 25_000;
// Don't auto-buy upgrades cheaper than this until t > this — early-game
// player should have other priorities (cargo runs, fuel). Keeps the audit
// honest about pacing rather than blowing all cash on upg_cargo_1 at t=20.
const UPGRADE_FIRST_BUY_TICK = 50;
// Slot-by-slot priority for the auto-purchaser. Cargo first (multiplies
// every trade), then engine (more trips), fuel (range), systems (utility),
// hull, weapons. A "good player" focuses on tradeable wins.
const SLOT_PRIORITY = ["cargo", "engine", "fuel", "systems", "hull", "weapon"] as const;

interface UpgradeRecord {
  good: GoodId;
  def: ShipUpgradeDef;
  basePrice: number;
  // Per-seed first-tick metrics (Infinity if never reached this seed).
  affordableTicks: number[];
  reachableTicks: number[];
  installedTicks: number[];
  // Bookkeeping — which stations stock this upgrade. Computed once.
  stockingStations: string[];
}

type CrewKey = `${"captain" | "mechanic" | "navigator"}_T${1 | 2 | 3}`;

interface CrewRecord {
  key: CrewKey;
  role: "captain" | "mechanic" | "navigator";
  tier: 1 | 2 | 3;
  // First tick the player saw an offer of this role+tier they could afford
  // while standing at that station. (Affordability without colocation isn't
  // useful for hires — you have to BE there.)
  affordableTicks: number[];
  hiredTicks: number[];
  // Sample of offer prices observed across all seeds, for sanity reporting.
  observedOfferPrices: number[];
  // Sample of hire-cost AT first affordability (so we know the price the
  // unlock happened at, not a generic "median").
  unlockOfferPrices: number[];
}

// --- world drivers ---------------------------------------------------------

function makeAuditWorld(seedIdx: number): World {
  // Mix of starter universe + small generated world per seed so the audit
  // captures both the canonical pacing AND seed-driven variance.
  // seedIdx 0 → starter universe; otherwise generated.
  if (seedIdx === 0) {
    return createWorld();
  }
  const w = generateWorld({
    seed: seedIdx * 17 + 3,
    locationCount: 12,
    traderCount: 18,
    player: null,
  });
  // generateWorld(player: null) produces a world with no player ship — add
  // one ourselves at a trade-hub (matching the starter universe's "Haven"
  // start). pickArchetypeMix shuffles, so we can't assume locations[0] is
  // a hub; find one explicitly so the audit is comparable across seeds.
  const ids = Object.keys(w.locations);
  const hubId = ids.find(id => w.locations[id].traits.tags.includes("trade-hub")) ?? ids[0];
  const made = makePlayer({ startingFunds: 55_000, startingLocation: hubId, startingShipName: "Voyager" });
  w.traders[made.ship.id] = made.ship;
  w.player = made.player;
  return w;
}

function getPlayerShip(world: World): Trader {
  const id = world.player!.shipIds[0];
  const ship = world.traders[id];
  if (!ship) throw new Error(`Audit: player ship ${id} missing`);
  return ship;
}

function tryAutoUpgrade(world: World, ship: Trader, record: Map<GoodId, UpgradeRecord>): void {
  if (ship.state !== "idle") return;
  if (world.tick < UPGRADE_FIRST_BUY_TICK) return;
  const market = world.markets[ship.location];
  if (!market) return;
  // Walk slots in priority order — buy ONE upgrade per visit (don't drain
  // the bank in a single tick) and only when funds comfortably cover it.
  for (const slot of SLOT_PRIORITY) {
    const installed = ship.upgrades?.[slot];
    const installedDef = installed ? SHIP_UPGRADES[installed] : null;
    const installedTier = installedDef?.tier ?? 0;
    // Best stocked-here upgrade for this slot at a higher tier than current.
    const candidates: ShipUpgradeDef[] = [];
    for (const def of Object.values(SHIP_UPGRADES)) {
      if (def.slot !== slot) continue;
      if (def.tier <= installedTier) continue;
      const stock = market.stock[def.id] ?? 0;
      if (stock < 1) continue;
      candidates.push(def);
    }
    if (candidates.length === 0) continue;
    // Pick the cheapest valid upgrade (climbs ladder one rung at a time).
    candidates.sort((a, b) => a.tier - b.tier || (world.goods[a.id]?.basePrice ?? 0) - (world.goods[b.id]?.basePrice ?? 0));
    for (const def of candidates) {
      const price = world.goods[def.id]?.basePrice ?? 0;
      if (ship.funds < price + UPGRADE_RESERVE_FUNDS) continue;
      const result = installUpgradeFromMarket(world, ship, def.id);
      if (result.ok) {
        const rec = record.get(def.id);
        if (rec && rec.installedTicks[rec.installedTicks.length - 1] === Infinity) {
          rec.installedTicks[rec.installedTicks.length - 1] = world.tick;
        }
        return;             // one upgrade per tick — keeps pacing realistic
      }
    }
  }
}

function tryAutoHire(world: World, ship: Trader, record: Map<CrewKey, CrewRecord>): void {
  if (ship.state !== "idle") return;
  // Look at hires posted at this station and try to take one we want.
  const offersHere = Object.values(world.hires).filter(h => h.location === ship.location);
  if (offersHere.length === 0) return;

  // Note all observed offer prices for the audit, regardless of whether
  // we hire (some seeds will never have funds for them — that's data).
  for (const h of offersHere) {
    const tier = (h.tier as 1 | 2 | 3);
    if (tier !== 1 && tier !== 2 && tier !== 3) continue;
    const k: CrewKey = `${h.role}_T${tier}`;
    const rec = record.get(k);
    if (!rec) continue;
    rec.observedOfferPrices.push(h.hireCost);
    if (ship.funds >= h.hireCost) {
      // First tick the player could afford this offer kind in person.
      const last = rec.affordableTicks[rec.affordableTicks.length - 1];
      if (last === Infinity) {
        rec.affordableTicks[rec.affordableTicks.length - 1] = world.tick;
        rec.unlockOfferPrices.push(h.hireCost);
      }
    }
  }

  // Hiring policy:
  //   1. If we don't have a real captain (ours is the synthetic), buy ANY
  //      affordable captain offer ASAP — it removes the audit-only crutch
  //      and lets us record the actual unlock tick.
  //   2. Otherwise prefer mechanic (debt suppression), then navigator.
  // Only hire when funds comfortably exceed cost + a reserve.
  const HIRE_RESERVE = 15_000;
  const realCaptain = ship.crew?.captain && ship.crew.captain.id !== AUDIT_CAPTAIN.id;
  const needs: ("captain" | "mechanic" | "navigator")[] = [];
  if (!realCaptain) needs.push("captain");
  if (!hasCrew(ship, "mechanic")) needs.push("mechanic");
  if (!hasCrew(ship, "navigator")) needs.push("navigator");

  for (const role of needs) {
    const candidate = offersHere
      .filter(h => h.role === role && h.hireCost + HIRE_RESERVE <= ship.funds)
      .sort((a, b) => b.tier - a.tier || a.hireCost - b.hireCost)[0];
    if (!candidate) continue;
    const r = hireCrew(world, ship, candidate.id);
    if (r.ok) {
      const k: CrewKey = `${candidate.role}_T${candidate.tier as 1 | 2 | 3}`;
      const rec = record.get(k);
      if (rec) {
        const last = rec.hiredTicks[rec.hiredTicks.length - 1];
        if (last === Infinity) rec.hiredTicks[rec.hiredTicks.length - 1] = world.tick;
      }
      // hire fired recompute internally
      return;
    }
  }
}

// Track first-affordable tick (cash only) and first-reachable tick (cash AND
// at a station that stocks it) per upgrade. Called every tick.
function sampleUpgradeAffordability(world: World, ship: Trader, record: Map<GoodId, UpgradeRecord>): void {
  for (const rec of record.values()) {
    const lastIdx = rec.affordableTicks.length - 1;
    if (rec.affordableTicks[lastIdx] === Infinity && ship.funds >= rec.basePrice) {
      rec.affordableTicks[lastIdx] = world.tick;
    }
    if (rec.reachableTicks[lastIdx] === Infinity) {
      const market = world.markets[ship.location];
      const stock = market?.stock[rec.good] ?? 0;
      if (ship.funds >= rec.basePrice && stock >= 1 && ship.state === "idle") {
        rec.reachableTicks[lastIdx] = world.tick;
      }
    }
  }
}

// --- the run loop ----------------------------------------------------------

interface RunResult {
  upgrades: Map<GoodId, UpgradeRecord>;
  crew: Map<CrewKey, CrewRecord>;
  fundsTrace: { tick: number; funds: number; cargoValue: number }[];
}

function makeUpgradeRecords(world: World): Map<GoodId, UpgradeRecord> {
  const m = new Map<GoodId, UpgradeRecord>();
  for (const [id, def] of Object.entries(SHIP_UPGRADES)) {
    const stockingStations: string[] = [];
    for (const loc of Object.values(world.locations)) {
      if ((loc.targetStock[id] ?? 0) > 0) stockingStations.push(loc.name);
    }
    m.set(id, {
      good: id,
      def,
      basePrice: world.goods[id]?.basePrice ?? 0,
      affordableTicks: [],
      reachableTicks: [],
      installedTicks: [],
      stockingStations,
    });
  }
  return m;
}

function makeCrewRecords(): Map<CrewKey, CrewRecord> {
  const m = new Map<CrewKey, CrewRecord>();
  for (const role of ["captain", "mechanic", "navigator"] as const) {
    for (const tier of [1, 2, 3] as const) {
      const k: CrewKey = `${role}_T${tier}`;
      m.set(k, {
        key: k,
        role,
        tier,
        affordableTicks: [],
        hiredTicks: [],
        observedOfferPrices: [],
        unlockOfferPrices: [],
      });
    }
  }
  return m;
}

function runOneSeed(seedIdx: number, sharedUpgrades: Map<GoodId, UpgradeRecord>, sharedCrew: Map<CrewKey, CrewRecord>): RunResult {
  const world = makeAuditWorld(seedIdx);

  // Push a fresh "Infinity" slot for this seed onto every record.
  for (const rec of sharedUpgrades.values()) {
    rec.affordableTicks.push(Infinity);
    rec.reachableTicks.push(Infinity);
    rec.installedTicks.push(Infinity);
  }
  for (const rec of sharedCrew.values()) {
    rec.affordableTicks.push(Infinity);
    rec.hiredTicks.push(Infinity);
  }

  const ship = getPlayerShip(world);
  ship.pilot = "auto";
  ship.crew = ship.crew ?? {};
  // Inject synthetic captain so the autopilot runs from t=0. We'll swap it
  // out for a real one as soon as one is hired.
  ship.crew.captain = AUDIT_CAPTAIN;
  recomputeShipStats(ship);

  const fundsTrace: RunResult["fundsTrace"] = [];

  for (let i = 0; i < HORIZON; i++) {
    // Pre-tick player actions: repair, hire, upgrade. Sample affordability
    // before tickWorld in case the tick changes funds (it normally does).
    if (ship.state === "idle") {
      // Repair when debt is meaningful and we can pay without bankrupting.
      const debt = ship.maintenanceDebt ?? 0;
      if (debt > 5_000 && ship.funds > debt + 10_000) {
        repairShip(world, ship);
      }
      tryAutoHire(world, ship, sharedCrew);
      tryAutoUpgrade(world, ship, sharedUpgrades);
    }

    sampleUpgradeAffordability(world, ship, sharedUpgrades);

    tickWorld(world);

    if (i % 100 === 0 || i === HORIZON - 1) {
      const cargoValue = ship.cargo.reduce((s, l) => s + l.qty * (world.goods[l.good]?.basePrice ?? 0), 0);
      fundsTrace.push({ tick: world.tick, funds: ship.funds, cargoValue });
    }
  }

  return { upgrades: sharedUpgrades, crew: sharedCrew, fundsTrace };
}

// --- aggregate + report ---------------------------------------------------

function median(xs: number[]): number {
  const finite = xs.filter(x => Number.isFinite(x));
  if (finite.length === 0) return Infinity;
  const sorted = [...finite].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function neverFraction(xs: number[]): number {
  return xs.filter(x => !Number.isFinite(x)).length / Math.max(1, xs.length);
}

function fmtTick(t: number): string {
  if (!Number.isFinite(t)) return "  never";
  return `t=${t.toString().padStart(5)}`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "  —  ";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + "%";
}

interface UpgradeSummary {
  good: GoodId;
  name: string;
  slot: string;
  tier: number;
  price: number;
  effect: string;
  affordableMedian: number;
  reachableMedian: number;
  installedMedian: number;
  installedFraction: number;
  reachableFraction: number;
  stations: string;
}

function summarizeUpgrades(records: Map<GoodId, UpgradeRecord>): UpgradeSummary[] {
  const out: UpgradeSummary[] = [];
  for (const rec of records.values()) {
    out.push({
      good: rec.good,
      name: rec.def.name,
      slot: rec.def.slot,
      tier: rec.def.tier,
      price: rec.basePrice,
      effect: upgradeEffectText(rec.def),
      affordableMedian: median(rec.affordableTicks),
      reachableMedian: median(rec.reachableTicks),
      installedMedian: median(rec.installedTicks),
      installedFraction: 1 - neverFraction(rec.installedTicks),
      reachableFraction: 1 - neverFraction(rec.reachableTicks),
      stations: rec.stockingStations.join(", ") || "(none)",
    });
  }
  return out;
}

interface CrewSummary {
  role: string;
  tier: number;
  affordableMedian: number;
  hiredMedian: number;
  hiredFraction: number;
  unlockMedianPrice: number;
  observedMedianPrice: number;
  observedSampleCount: number;
}

function summarizeCrew(records: Map<CrewKey, CrewRecord>): CrewSummary[] {
  const out: CrewSummary[] = [];
  for (const rec of records.values()) {
    const observedMedian = median(rec.observedOfferPrices);
    const unlockMedian = median(rec.unlockOfferPrices);
    out.push({
      role: rec.role,
      tier: rec.tier,
      affordableMedian: median(rec.affordableTicks),
      hiredMedian: median(rec.hiredTicks),
      hiredFraction: 1 - neverFraction(rec.hiredTicks),
      unlockMedianPrice: unlockMedian,
      observedMedianPrice: observedMedian,
      observedSampleCount: rec.observedOfferPrices.length,
    });
  }
  return out;
}

function printUpgradeTable(rows: UpgradeSummary[]): void {
  console.log(``);
  console.log(`━━━ Upgrades — pacing across ${SEED_COUNT} seed(s), ${HORIZON} ticks ━━━`);
  console.log(``);
  console.log(`  T  slot      price    affordable  reachable   installed   inst%  ${"upgrade".padEnd(34)}  effect`);
  console.log(`  ─  ────  ─────────  ──────────  ──────────  ──────────  ──────  ${"─".repeat(34)}  ${"─".repeat(40)}`);
  // Sort by reachable median tick (the most "real" pacing signal). Ties
  // broken by tier then price.
  const sorted = [...rows].sort((a, b) =>
    (a.reachableMedian - b.reachableMedian)
    || (a.tier - b.tier)
    || (a.price - b.price),
  );
  for (const r of sorted) {
    console.log(
      `  ${r.tier}  ${r.slot.padEnd(4)}  Ç${r.price.toLocaleString().padStart(8)}  `
      + `${fmtTick(r.affordableMedian).padStart(10)}  ${fmtTick(r.reachableMedian).padStart(10)}  `
      + `${fmtTick(r.installedMedian).padStart(10)}  ${pct(r.installedFraction).padStart(5)}  `
      + `${r.name.padEnd(34)}  ${r.effect}`,
    );
  }
}

function printCrewTable(rows: CrewSummary[]): void {
  console.log(``);
  console.log(`━━━ Crew — first-affordable in-person across ${SEED_COUNT} seed(s) ━━━`);
  console.log(``);
  console.log(`  role        T  median offer  median unlock-price  affordable  hired       hired%  offers seen`);
  console.log(`  ────────    ─  ────────────  ───────────────────  ──────────  ──────────  ──────  ───────────`);
  const sorted = [...rows].sort((a, b) =>
    a.role.localeCompare(b.role) || a.tier - b.tier,
  );
  for (const r of sorted) {
    console.log(
      `  ${r.role.padEnd(10)}  ${r.tier}  ${fmtMoney(r.observedMedianPrice).padStart(8).padEnd(12)}  `
      + `${fmtMoney(r.unlockMedianPrice).padStart(8).padEnd(19)}  `
      + `${fmtTick(r.affordableMedian).padStart(10)}  ${fmtTick(r.hiredMedian).padStart(10)}  `
      + `${pct(r.hiredFraction).padStart(5)}  ${r.observedSampleCount.toString().padStart(7)}`,
    );
  }
}

function printTimeline(upgrades: UpgradeSummary[], crew: CrewSummary[]): void {
  console.log(``);
  console.log(`━━━ Unlock timeline (median first-reachable / first-hired across seeds) ━━━`);
  console.log(``);
  interface TLEntry { tick: number; line: string }
  const entries: TLEntry[] = [];
  for (const r of upgrades) {
    if (!Number.isFinite(r.reachableMedian)) continue;
    entries.push({
      tick: r.reachableMedian,
      line: `[upgrade ${r.slot.padEnd(7)} T${r.tier}]  Ç${r.price.toString().padStart(8)}  ${r.name.padEnd(32)}  ${r.effect}`,
    });
  }
  for (const r of crew) {
    if (!Number.isFinite(r.affordableMedian)) continue;
    entries.push({
      tick: r.affordableMedian,
      line: `[crew    ${r.role.padEnd(7)} T${r.tier}]  Ç${(r.observedMedianPrice).toFixed(0).padStart(8)}  (median offer Ç${fmtMoney(r.observedMedianPrice)})`,
    });
  }
  entries.sort((a, b) => a.tick - b.tick);

  let prevTick = 0;
  for (const e of entries) {
    const gap = e.tick - prevTick;
    const gapNote = gap >= 500 ? `   ⟶ ${gap}t gap` : "";
    console.log(`  ${fmtTick(e.tick)}  ${e.line}${gapNote}`);
    prevTick = e.tick;
  }
}

function printDeadZones(upgrades: UpgradeSummary[], crew: CrewSummary[]): void {
  console.log(``);
  console.log(`━━━ Pacing dead zones — gaps ≥ 400 ticks with no new unlocks ━━━`);
  console.log(``);
  const ticks: { tick: number; label: string }[] = [];
  for (const r of upgrades) {
    if (!Number.isFinite(r.reachableMedian)) continue;
    ticks.push({ tick: r.reachableMedian, label: r.name });
  }
  for (const r of crew) {
    if (!Number.isFinite(r.affordableMedian)) continue;
    ticks.push({ tick: r.affordableMedian, label: `${r.role} T${r.tier}` });
  }
  ticks.sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i].tick - ticks[i - 1].tick;
    if (gap >= 400) {
      console.log(`  ${fmtTick(ticks[i - 1].tick)} → ${fmtTick(ticks[i].tick)}  (Δ${gap})  between "${ticks[i - 1].label}" and "${ticks[i].label}"`);
    }
  }

  // Items that NEVER reached affordability — biggest red flags
  const stranded = upgrades.filter(u => !Number.isFinite(u.reachableMedian));
  if (stranded.length > 0) {
    console.log(``);
    console.log(`  ${stranded.length} upgrade(s) NEVER unlocked in any seed within ${HORIZON} ticks:`);
    for (const u of stranded.sort((a, b) => a.price - b.price)) {
      console.log(`    Ç${u.price.toString().padStart(8)}  ${u.name.padEnd(32)}  (stocked at: ${u.stations})`);
    }
  }
  const strandedCrew = crew.filter(c => !Number.isFinite(c.affordableMedian));
  if (strandedCrew.length > 0) {
    console.log(``);
    console.log(`  ${strandedCrew.length} crew tier(s) never affordable:`);
    for (const c of strandedCrew) {
      console.log(`    ${c.role} T${c.tier}    median offer Ç${fmtMoney(c.observedMedianPrice)}    offers seen: ${c.observedSampleCount}`);
    }
  }
}

function printFundsCurve(world0: World, traces: RunResult["fundsTrace"][]): void {
  void world0;
  console.log(``);
  console.log(`━━━ Player wealth trajectory (median funds across seeds) ━━━`);
  console.log(``);
  // Align traces by tick, take median funds per sample.
  const tickSet = new Set<number>();
  for (const tr of traces) for (const s of tr) tickSet.add(s.tick);
  const ticks = [...tickSet].sort((a, b) => a - b);
  console.log(`  tick     median_funds   median_cargoVal   p25_funds   p75_funds`);
  for (const t of ticks) {
    const fundsAtT: number[] = [];
    const cargoAtT: number[] = [];
    for (const tr of traces) {
      const s = tr.find(x => x.tick === t);
      if (s) { fundsAtT.push(s.funds); cargoAtT.push(s.cargoValue); }
    }
    if (fundsAtT.length === 0) continue;
    const sorted = [...fundsAtT].sort((a, b) => a - b);
    const m = sorted[Math.floor(sorted.length / 2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const cm = [...cargoAtT].sort((a, b) => a - b)[Math.floor(cargoAtT.length / 2)];
    if (t % 200 === 0 || t === ticks[ticks.length - 1]) {
      console.log(`  ${t.toString().padStart(6)}    Ç${fmtMoney(m).padStart(8)}      Ç${fmtMoney(cm).padStart(8)}      Ç${fmtMoney(p25).padStart(8)}    Ç${fmtMoney(p75).padStart(8)}`);
    }
  }
}

// --- main ------------------------------------------------------------------

console.log(`\n=== Progression audit ===\nhorizon=${HORIZON} ticks, seeds=${SEED_COUNT}`);
console.log(`assumes "good play": autopilot trading from t=0, climbs upgrade ladder when funds + station match, hires real crew when affordable.`);
console.log(`column meanings:`);
console.log(`  affordable = first tick player funds ≥ price (cash check only — ignores location)`);
console.log(`  reachable  = first tick player funds ≥ price AND idle at a station that stocks it`);
console.log(`  installed  = first tick the auto-buyer actually purchased + installed it`);
console.log(`  inst%      = fraction of seeds where the upgrade was installed within HORIZON`);
console.log(``);

// Build shared accumulators using the first world's upgrade catalog.
const seedZeroWorld = makeAuditWorld(0);
const sharedUpgrades = makeUpgradeRecords(seedZeroWorld);
const sharedCrew = makeCrewRecords();
const traces: RunResult["fundsTrace"][] = [];

for (let s = 0; s < SEED_COUNT; s++) {
  const result = runOneSeed(s, sharedUpgrades, sharedCrew);
  traces.push(result.fundsTrace);
  process.stdout.write(`  seed ${s}: ✓\n`);
}

const upgradeSummary = summarizeUpgrades(sharedUpgrades);
const crewSummary = summarizeCrew(sharedCrew);

printFundsCurve(seedZeroWorld, traces);
printUpgradeTable(upgradeSummary);
printCrewTable(crewSummary);
printTimeline(upgradeSummary, crewSummary);
printDeadZones(upgradeSummary, crewSummary);

// Final summary line for at-a-glance comparison across runs.
const reachedCount = upgradeSummary.filter(u => Number.isFinite(u.reachableMedian)).length;
const installedCount = upgradeSummary.filter(u => u.installedFraction > 0.5).length;
const crewReached = crewSummary.filter(c => Number.isFinite(c.affordableMedian)).length;
const earliestReach = Math.min(...upgradeSummary.map(u => u.reachableMedian).filter(Number.isFinite));
const latestReach = Math.max(...upgradeSummary.map(u => u.reachableMedian).filter(Number.isFinite));
console.log(``);
console.log(`━━━ Summary ━━━`);
console.log(`  upgrades reachable in median: ${reachedCount} / ${upgradeSummary.length}`);
console.log(`  upgrades installed in >50% of seeds: ${installedCount} / ${upgradeSummary.length}`);
console.log(`  crew tiers reached in median: ${crewReached} / ${crewSummary.length}`);
if (Number.isFinite(earliestReach)) console.log(`  first unlock at t=${earliestReach}, last unlock at t=${latestReach}`);

// --- emit the director-facing report files --------------------------------
const reportDir = join(process.cwd(), "docs");
const paths = writeReports({
  generatedAt: new Date().toISOString().replace("T", " ").replace(/\..*/, " UTC"),
  horizon: HORIZON,
  seedCount: SEED_COUNT,
  upgrades: upgradeSummary,
  crew: crewSummary,
  traces,
}, reportDir);
console.log(``);
console.log(`━━━ Reports written ━━━`);
console.log(`  HTML: ${paths.html}`);
console.log(`  MD:   ${paths.md}`);
