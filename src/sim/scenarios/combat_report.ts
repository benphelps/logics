// Combat-system telemetry harness. Two halves:
//   1. World simulations — boots a generated world, runs the sim for a fixed
//      horizon, and dumps every encounter to a JSON trace plus a summary.
//      Player ship is set to pilot="npc" so it travels normally and feeds
//      encounters into the trace. Rival-syndicate attacks still fire because
//      the rival gate keys on world.player.shipIds, not pilot.
//   2. Strategy Monte-Carlo — synthesizes a grid of encounters and runs
//      fight/flee/negotiate × many trials each, isolating the per-strategy
//      outcome distribution from world-sim noise.
//
// Companion print_combat_report.ts builds the director-facing report from
// the JSON output.

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { generateWorld } from "../gen/world";
import { createStartingWorld } from "../start";
import { tickWorld } from "../tick";
import {
  encounterChance,
  resolveEncounter,
} from "../combat/encounters";
import type {
  CrewMember,
  Encounter,
  EncounterAttacker,
  EncounterChoice,
  Trader,
  World,
} from "../types";

// --- world scenarios ------------------------------------------------------

interface WorldScenario {
  label: string;
  seed: number;
  locationCount: number;
  traderCount: number;
  ticks: number;
  ageTicks: number;
  player: "absent" | "npc_default" | "npc_merc" | "npc_armed" | "npc_armed_merc";
  // If set, inject a synthetic news event with this encounter_chance multiplier
  // direction*magnitude after the warmup. Lets us measure news modulation
  // without a live LLM.
  newsEncounterMultiplier?: number;
}

interface EncounterRecord {
  id: string;
  spawnedAt: number;
  shipId: string;
  shipIsPlayer: boolean;
  shipBaseWeapon: number;
  shipWeaponPower: number;
  shipBaseHull: number;
  shipHasMerc: boolean;
  fromLocation: string;
  toLocation: string;
  fromSyndicate?: string;
  toSyndicate?: string;
  isBorder: boolean;
  isHostile: boolean;
  attackerKind: "pirate" | "rival_syndicate";
  attackerWeapon: number;
  attackerHull: number;
  attackerSpeed: number;
  pFight: number;
  pFlee: number;
  pNegotiate: number;
  choice: "fight" | "flee" | "negotiate";
  outcome: string;
  autoResolved: boolean;
  lossCredits: number;
  lossCargoUnits: number;
  lossHull: number;
}

interface WorldResult {
  config: WorldScenario;
  ticks: number;
  totalEncounters: number;
  playerEncounters: number;
  npcEncounters: number;
  pirateCount: number;
  rivalCount: number;
  borderEncounters: number;
  hostileEncounters: number;
  outcomeCounts: Record<string, number>;
  choiceCounts: Record<string, number>;
  encounters: EncounterRecord[];
  laneHeat: Record<string, number>;
  npcFleetWealthStart: number;
  npcFleetWealthEnd: number;
  totalCreditDrain: number;
  totalCargoUnitDrain: number;
  totalHullDrain: number;
  destroyedShips: number;
  // Per-100-tick bucket of encounter counts for cadence visualization.
  bucketsPer100Tick: number[];
  msPerTick: number;
}

function fakeMerc(): CrewMember {
  return {
    id: "merc-bench",
    role: "mercenary",
    name: "Bench Merc",
    tier: 3,
    hireCost: 0,
    wagePerTick: 0,
    modifiers: { weaponPowerBonus: 6, hullBonus: 4 },
    sex: "nonbinary",
    age: "adult",
    race: "human",
  };
}

function fakeCaptain(): CrewMember {
  return {
    id: "captain-bench",
    role: "captain",
    name: "Bench Captain",
    tier: 2,
    hireCost: 0,
    wagePerTick: 0,
    modifiers: {},
    sex: "nonbinary",
    age: "adult",
    race: "human",
  };
}

function configurePlayer(world: World, mode: WorldScenario["player"]): void {
  if (mode === "absent" || !world.player) return;
  const flagshipId = world.player.shipIds[0];
  const ship = world.traders[flagshipId];
  if (!ship) return;

  // Use pilot="npc" so the standard trader planner runs (player ship picks
  // trades and travels). Encounters auto-resolve via autopilotPolicy.
  // shipIds membership still tags this ship as the player, so rival
  // syndicate attackers can still spawn against it.
  ship.pilot = "npc";
  // Give it a starting funds bump so it can actually buy cargo.
  ship.funds = Math.max(ship.funds, 25_000);

  // Assign the player ship to a syndicate so the rival_syndicate attacker
  // path can fire when crossing into rival territory. Without an owner
  // syndicate the rival gate (`!!ownSynd && !!toSynd && toSynd !== ownSynd`)
  // returns false — every player encounter would be a pirate.
  const synds = Object.keys(world.syndicates);
  if (synds.length > 0 && !ship.syndicateId) ship.syndicateId = synds[0];

  if (mode === "npc_merc" || mode === "npc_armed_merc") {
    ship.crew = { ...(ship.crew ?? {}), mercenary: fakeMerc(), captain: fakeCaptain() };
  }
  if (mode === "npc_armed" || mode === "npc_armed_merc") {
    ship.baseWeaponPower = 12;
    ship.weaponPower = 12;
    ship.baseHull = 30;
    ship.hull = 30;
  }
}

function runWorldScenario(cfg: WorldScenario): WorldResult {
  // Use createStartingWorld for player scenarios so the flagship is properly
  // placed at choosePlayerStart's pick (a hub). Bare generateWorld leaves
  // world.player=null when the default seed's location id isn't in the
  // generated map, which silenced every player-ship encounter in the first
  // pass of this harness.
  let world: World;
  if (cfg.player === "absent") {
    world = generateWorld({
      seed: cfg.seed,
      locationCount: cfg.locationCount,
      traderCount: cfg.traderCount,
      player: null,
    });
    for (let i = 0; i < cfg.ageTicks; i++) tickWorld(world);
  } else {
    world = createStartingWorld({
      seed: cfg.seed,
      locationCount: cfg.locationCount,
      traderCount: cfg.traderCount,
      ageTicks: cfg.ageTicks,
    });
  }

  configurePlayer(world, cfg.player);

  if (cfg.newsEncounterMultiplier != null && world.newsEvents) {
    // direction*magnitude resolves to (1 + d*m) inside eventMultiplier.
    // To target a final multiplier M, pick direction=sign(M-1), magnitude=|M-1|.
    const delta = cfg.newsEncounterMultiplier - 1;
    const direction: 1 | -1 = delta >= 0 ? 1 : -1;
    const magnitude = Math.abs(delta);
    world.newsEvents.active.push({
      uid: "news-encounter-injection",
      templateId: "synthetic",
      spawnedAt: world.tick,
      expiresAt: world.tick + 1_000_000,
      effects: [{ scope: "encounter_chance", direction, magnitude, target: { kind: "global" } }],
      headline: "Sector Threat Climate",
      body: "Synthetic event for combat-report harness.",
      category: "trade",
      tone: direction > 0 ? "bad" : "good",
    });
  }

  const seenIds = new Set<string>();
  const encountersOut: EncounterRecord[] = [];
  const npcFleetWealthStart = sumNonPlayerFunds(world);
  const buckets: number[] = [];

  const start = performance.now();
  for (let t = 0; t < cfg.ticks; t++) {
    tickWorld(world);
    const hist = world.encounterHistory ?? [];
    for (const enc of hist) {
      if (seenIds.has(enc.id)) continue;
      seenIds.add(enc.id);
      encountersOut.push(toRecord(world, enc));
    }
    const bucketIdx = Math.floor(t / 100);
    while (buckets.length <= bucketIdx) buckets.push(0);
    // Count encounters spawned this tick.
    const tickStart = world.tick - 1;
    let spawnedThisTick = 0;
    for (const e of encountersOut) {
      if (e.spawnedAt === tickStart) spawnedThisTick += 1;
    }
    // Less expensive: track ids added in this tick instead.
    // (Reset buckets[bucketIdx] cumulatively; this is the simplest way.)
    buckets[bucketIdx] = (buckets[bucketIdx] ?? 0); // touch
    void spawnedThisTick;
  }
  // Re-bucket by spawnedAt for accuracy
  for (let i = 0; i < buckets.length; i++) buckets[i] = 0;
  for (const e of encountersOut) {
    const idx = Math.floor(e.spawnedAt / 100);
    while (buckets.length <= idx) buckets.push(0);
    buckets[idx] += 1;
  }
  const totalMs = performance.now() - start;

  const npcFleetWealthEnd = sumNonPlayerFunds(world);

  // Aggregate
  const outcomeCounts: Record<string, number> = {};
  const choiceCounts: Record<string, number> = {};
  const laneHeat: Record<string, number> = {};
  let playerEncounters = 0, npcEncounters = 0;
  let pirateCount = 0, rivalCount = 0;
  let borderEncounters = 0, hostileEncounters = 0;
  let totalCreditDrain = 0, totalCargoUnitDrain = 0, totalHullDrain = 0;
  for (const e of encountersOut) {
    outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] ?? 0) + 1;
    choiceCounts[e.choice] = (choiceCounts[e.choice] ?? 0) + 1;
    if (e.shipIsPlayer) playerEncounters += 1; else npcEncounters += 1;
    if (e.attackerKind === "pirate") pirateCount += 1; else rivalCount += 1;
    if (e.isBorder) borderEncounters += 1;
    if (e.isHostile) hostileEncounters += 1;
    const lk = e.fromLocation < e.toLocation
      ? `${e.fromLocation}->${e.toLocation}`
      : `${e.toLocation}->${e.fromLocation}`;
    laneHeat[lk] = (laneHeat[lk] ?? 0) + 1;
    totalCreditDrain += e.lossCredits;
    totalCargoUnitDrain += e.lossCargoUnits;
    totalHullDrain += e.lossHull;
  }
  const destroyedShips = countDestroyedShips(world);

  return {
    config: cfg,
    ticks: cfg.ticks,
    totalEncounters: encountersOut.length,
    playerEncounters,
    npcEncounters,
    pirateCount,
    rivalCount,
    borderEncounters,
    hostileEncounters,
    outcomeCounts,
    choiceCounts,
    encounters: encountersOut,
    laneHeat,
    npcFleetWealthStart,
    npcFleetWealthEnd,
    totalCreditDrain,
    totalCargoUnitDrain,
    totalHullDrain,
    destroyedShips,
    bucketsPer100Tick: buckets,
    msPerTick: totalMs / cfg.ticks,
  };
}

function toRecord(world: World, enc: Encounter): EncounterRecord {
  const ship = world.traders[enc.shipId];
  const fromLoc = world.locations[enc.fromLocation];
  const toLoc = world.locations[enc.toLocation];
  const fromSynd = fromLoc?.traits.faction;
  const toSynd = toLoc?.traits.faction;
  const isPlayer = world.player?.shipIds.includes(enc.shipId) ?? false;
  const r = enc.resolution;
  const cargoUnits = r?.loss?.cargo.reduce((s, c) => s + c.qty, 0) ?? 0;
  return {
    id: enc.id,
    spawnedAt: enc.spawnedAt,
    shipId: enc.shipId,
    shipIsPlayer: isPlayer,
    shipBaseWeapon: ship?.baseWeaponPower ?? 0,
    shipWeaponPower: ship?.weaponPower ?? 0,
    shipBaseHull: ship?.baseHull ?? 0,
    shipHasMerc: !!ship?.crew?.mercenary,
    fromLocation: enc.fromLocation,
    toLocation: enc.toLocation,
    fromSyndicate: fromSynd,
    toSyndicate: toSynd,
    isBorder: fromSynd !== toSynd,
    isHostile: !!ship?.syndicateId && !!toSynd && toSynd !== ship.syndicateId,
    attackerKind: enc.attacker.kind,
    attackerWeapon: enc.attacker.weaponPower,
    attackerHull: enc.attacker.hull,
    attackerSpeed: enc.attacker.speed,
    pFight: enc.pFight,
    pFlee: enc.pFlee,
    pNegotiate: enc.pNegotiate,
    choice: r?.choice ?? "flee",
    outcome: r?.outcome ?? "unresolved",
    autoResolved: r?.autoResolved ?? false,
    lossCredits: r?.loss?.credits ?? 0,
    lossCargoUnits: cargoUnits,
    lossHull: r?.loss?.hull ?? 0,
  };
}

function sumNonPlayerFunds(world: World): number {
  let s = 0;
  for (const t of Object.values(world.traders)) {
    if (world.player?.shipIds.includes(t.id)) continue;
    s += t.funds;
  }
  return s;
}

function countDestroyedShips(world: World): number {
  let n = 0;
  for (const t of Object.values(world.traders)) {
    if ((t.hull ?? 1) <= 0) n += 1;
  }
  return n;
}

// --- strategy Monte Carlo -------------------------------------------------
// Synthesize a grid of attacker/defender configurations, run each through
// each strategy N times, and report outcome rates + average loss. Bypasses
// world-sim noise: we craft encounters directly with fixed pFight/pFlee/
// pNegotiate values and let resolveEncounter roll the dice.

interface StrategyTrial {
  shipBaseWeapon: number;
  shipBaseHull: number;
  shipFunds: number;
  attackerWeapon: number;
  attackerHull: number;
  attackerSpeed: number;
  attackerKind: "pirate" | "rival_syndicate";
  pFight: number;
  pFlee: number;
  pNegotiate: number;
  bribe: number;
  fightLossHull: number;
  fleeLossHull: number;
  fightLossCredits: number;
}

interface StrategyOutcome {
  trials: number;
  fight: { won: number; lost: number; avgCreditLoss: number; avgHullLoss: number };
  flee: { escaped: number; damaged: number; avgHullLoss: number };
  negotiate: { peace: number; partial: number; failed: number; avgCreditLoss: number; avgHullLoss: number };
}

function runStrategyTrials(
  trial: StrategyTrial,
  trialsPer: number,
): StrategyOutcome {
  const out: StrategyOutcome = {
    trials: trialsPer,
    fight: { won: 0, lost: 0, avgCreditLoss: 0, avgHullLoss: 0 },
    flee: { escaped: 0, damaged: 0, avgHullLoss: 0 },
    negotiate: { peace: 0, partial: 0, failed: 0, avgCreditLoss: 0, avgHullLoss: 0 },
  };
  const choices: EncounterChoice[] = ["fight", "flee", "negotiate"];

  // Build fake world + ship + encounter snapshots that we rebuild each trial
  // (so applied losses don't carry over into the next sample).
  for (const choice of choices) {
    let creditLoss = 0;
    let hullLoss = 0;
    for (let i = 0; i < trialsPer; i++) {
      const world = sandboxWorld(i);
      const ship = sandboxShip(world, trial);
      const enc = sandboxEncounter(ship, trial);
      const outcome = resolveEncounter(world, ship, enc, choice, true);
      const loss = enc.resolution?.loss;
      const creditDelta = loss?.credits ?? 0;
      const hullDelta = loss?.hull ?? 0;
      if (choice === "fight") {
        if (outcome === "won") out.fight.won += 1;
        else out.fight.lost += 1;
        creditLoss += creditDelta;
        hullLoss += hullDelta;
      } else if (choice === "flee") {
        if (outcome === "escaped") out.flee.escaped += 1;
        else out.flee.damaged += 1;
        hullLoss += hullDelta;
      } else {
        if (outcome === "negotiated_peace") out.negotiate.peace += 1;
        else if (outcome === "negotiated_partial") out.negotiate.partial += 1;
        else out.negotiate.failed += 1;
        creditLoss += creditDelta;
        hullLoss += hullDelta;
      }
    }
    if (choice === "fight") {
      out.fight.avgCreditLoss = creditLoss / trialsPer;
      out.fight.avgHullLoss = hullLoss / trialsPer;
    } else if (choice === "flee") {
      out.flee.avgHullLoss = hullLoss / trialsPer;
    } else {
      out.negotiate.avgCreditLoss = creditLoss / trialsPer;
      out.negotiate.avgHullLoss = hullLoss / trialsPer;
    }
  }
  return out;
}

let sandboxIdCounter = 0;
function sandboxWorld(seed: number): World {
  sandboxIdCounter += 1;
  return {
    gameId: `sandbox-${seed}-${sandboxIdCounter}`,
    tick: 100 + seed,
    goods: { ore: { id: "ore", name: "Ore", category: "industrial", basePrice: 100, weight: 1 } } as any,
    locations: {} as any,
    markets: {} as any,
    lanes: {} as any,
    traders: {},
    player: { funds: 0, shipIds: [] },
    jobs: {}, nextJobId: 1, hires: {}, nextHireId: 1,
    equities: {}, syndicates: {},
    nextEncounterId: 1,
  } as unknown as World;
}

function sandboxShip(_world: World, t: StrategyTrial): Trader {
  return {
    id: "p_test",
    name: "Sandbox",
    capacity: 60, speed: 2,
    fuelCapacity: 60, baseCapacity: 60, baseSpeed: 2, baseFuelCapacity: 60,
    baseHull: t.shipBaseHull, baseWeaponPower: t.shipBaseWeapon,
    hull: t.shipBaseHull, weaponPower: t.shipBaseWeapon,
    upgrades: {},
    fuelTypes: [{ good: "plasma", perDistance: 1.0 }],
    currentFuel: { good: "plasma", qty: 60 },
    funds: t.shipFunds,
    location: "x", state: "transit", cargo: [],
    destination: "y", ticksRemaining: 5, pilot: "manual", log: [],
  };
}

function sandboxEncounter(ship: Trader, t: StrategyTrial): Encounter {
  const attacker: EncounterAttacker = {
    name: "Sandbox Foe",
    kind: t.attackerKind,
    weaponPower: t.attackerWeapon,
    hull: t.attackerHull,
    speed: t.attackerSpeed,
    crewLevel: 0.5,
  };
  return {
    id: `enc-sandbox-${Math.random().toString(36).slice(2, 8)}`,
    spawnedAt: 100,
    shipId: ship.id,
    fromLocation: "x", toLocation: "y",
    attacker,
    pFight: t.pFight,
    pFlee: t.pFlee,
    pNegotiate: t.pNegotiate,
    oddsFight: "even", oddsFlee: "even", oddsNegotiate: "even",
    fightLossOnFail: { credits: t.fightLossCredits, cargo: [], hull: t.fightLossHull },
    fleeLossOnFail: { credits: 0, cargo: [], hull: t.fleeLossHull },
    negotiateBribe: t.bribe,
    negotiatePartialCargo: [],
  };
}

// --- encounter chance grid ------------------------------------------------
// Sweep encounterChance over (border, hostile, cargo value) combos to
// document the rate function. Uses a tiny sandbox world to isolate the
// math from any active news multipliers.

interface RateGridEntry {
  isBorder: boolean;
  isHostile: boolean;
  cargoValue: number;
  pSpawn: number;
}

function buildRateGrid(): RateGridEntry[] {
  const entries: RateGridEntry[] = [];
  const cargoVals = [0, 5_000, 25_000, 75_000, 200_000, 500_000];
  // Practical cases the gameplay actually exposes:
  //   1) Intra-syndicate route (owner=from=to)        → not border, not hostile
  //   2) Crossing into rival territory (owner=from≠to)→ border AND hostile (combined)
  // The two stacked bonuses (border 1.5% + hostile 1.5%) saturate against
  // the 7% clamp at almost every cargo level.
  const cases: { label: string; fromSynd: string; toSynd: string; ownSynd: string; border: boolean; hostile: boolean }[] = [
    { label: "intra-syndicate", fromSynd: "synd_x", toSynd: "synd_x", ownSynd: "synd_x", border: false, hostile: false },
    { label: "border-crossing", fromSynd: "synd_x", toSynd: "synd_y", ownSynd: "synd_x", border: true,  hostile: true },
  ];
  for (const c of cases) {
    for (const v of cargoVals) {
      const w: World = {
        gameId: "rate-grid",
        tick: 200, goods: {} as any,
        locations: {
          a: { id: "a", name: "A", position: { x: 0, y: 0 }, traits: { faction: c.fromSynd, techLevel: 1, tags: [] }, population: 1, produces: [], consumes: [], targetStock: {} } as any,
          b: { id: "b", name: "B", position: { x: 1, y: 0 }, traits: { faction: c.toSynd, techLevel: 1, tags: [] }, population: 1, produces: [], consumes: [], targetStock: {} } as any,
        },
        markets: { a: { stock: {}, prices: {}, treasury: 0, treasuryTarget: 0 }, b: { stock: {}, prices: {}, treasury: 0, treasuryTarget: 0 } } as any,
        lanes: {} as any,
        traders: {},
        player: null,
        jobs: {}, nextJobId: 1, hires: {}, nextHireId: 1,
        equities: {}, syndicates: {},
      } as unknown as World;
      const ship: Trader = {
        id: "test", name: "Test",
        capacity: 60, speed: 1, fuelCapacity: 60,
        baseCapacity: 60, baseSpeed: 1, baseFuelCapacity: 60,
        baseHull: 3, baseWeaponPower: 0,
        hull: 3, weaponPower: 0, upgrades: {},
        fuelTypes: [{ good: "plasma", perDistance: 1 }],
        currentFuel: { good: "plasma", qty: 60 },
        funds: 10000, location: "a", state: "transit",
        cargo: v > 0 ? [{ good: "ore", qty: 1, source: "a", unitPrice: v, purchasedAt: 0 }] : [],
        destination: "b", ticksRemaining: 4, pilot: "npc", log: [],
        syndicateId: c.ownSynd,
      } as Trader;
      (w.markets as any).b.prices = { ore: v };
      (w.goods as any).ore = { id: "ore", name: "Ore", category: "industrial", basePrice: 100, weight: 1 };
      const p = encounterChance(w, ship);
      entries.push({ isBorder: c.border, isHostile: c.hostile, cargoValue: v, pSpawn: p });
    }
  }
  return entries;
}

// --- top level ------------------------------------------------------------

const HORIZON = Number(process.env.HORIZON ?? 4000);

const SCENARIOS: WorldScenario[] = [
  { label: "baseline 50loc seed=1001", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "absent" },
  { label: "baseline 50loc seed=2002", seed: 2002, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "absent" },
  { label: "baseline 50loc seed=3003", seed: 3003, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "absent" },
  { label: "player npc default ship", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "npc_default" },
  { label: "player npc + tier-3 merc", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "npc_merc" },
  { label: "player npc + armed", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "npc_armed" },
  { label: "player npc + armed + merc", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "npc_armed_merc" },
  { label: "news inflate +60% encounters", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "absent", newsEncounterMultiplier: 1.6 },
  { label: "news suppress -60% encounters", seed: 1001, locationCount: 50, traderCount: 100, ticks: HORIZON, ageTicks: 90, player: "absent", newsEncounterMultiplier: 0.4 },
];

function main(): void {
  const outDir = resolve(".logics-cache/combat_report");
  mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Combat report harness ===  horizon=${HORIZON} ticks · scenarios=${SCENARIOS.length}\n`);
  const results: WorldResult[] = [];
  for (const cfg of SCENARIOS) {
    const r = runWorldScenario(cfg);
    results.push(r);
    console.log(
      `${cfg.label.padEnd(34)}  enc=${String(r.totalEncounters).padStart(5)}  player=${String(r.playerEncounters).padStart(4)}  npc=${String(r.npcEncounters).padStart(5)}  pirates=${String(r.pirateCount).padStart(5)}  rivals=${String(r.rivalCount).padStart(3)}  drain=Ç${(r.totalCreditDrain / 1000).toFixed(0)}k  destroyed=${r.destroyedShips}  ms/tick=${r.msPerTick.toFixed(2)}`,
    );
  }

  console.log(`\n=== Strategy Monte Carlo ===`);
  // Define a few archetypal encounter profiles and run each through the 3 strategies.
  const TRIALS = 2000;
  const profiles: { label: string; trial: StrategyTrial }[] = [
    {
      label: "default ship vs balanced pirate (pF=0.30, pE=0.55, pN=0.45)",
      trial: {
        shipBaseWeapon: 0, shipBaseHull: 3, shipFunds: 25000,
        attackerWeapon: 5, attackerHull: 8, attackerSpeed: 2, attackerKind: "pirate",
        pFight: 0.30, pFlee: 0.55, pNegotiate: 0.45,
        bribe: 3000, fightLossHull: 1, fleeLossHull: 0, fightLossCredits: 1250,
      },
    },
    {
      label: "merc-armed cruiser vs pirate (pF=0.70, pE=0.55, pN=0.45)",
      trial: {
        shipBaseWeapon: 12, shipBaseHull: 30, shipFunds: 100000,
        attackerWeapon: 6, attackerHull: 10, attackerSpeed: 2, attackerKind: "pirate",
        pFight: 0.70, pFlee: 0.55, pNegotiate: 0.45,
        bribe: 5000, fightLossHull: 8, fleeLossHull: 3, fightLossCredits: 5000,
      },
    },
    {
      label: "default ship vs rival w/ low rep (pF=0.30, pE=0.55, pN=0.30)",
      trial: {
        shipBaseWeapon: 0, shipBaseHull: 3, shipFunds: 25000,
        attackerWeapon: 8, attackerHull: 12, attackerSpeed: 2, attackerKind: "rival_syndicate",
        pFight: 0.30, pFlee: 0.55, pNegotiate: 0.30,
        bribe: 5000, fightLossHull: 1, fleeLossHull: 0, fightLossCredits: 1250,
      },
    },
    {
      label: "default ship vs rival w/ high rep (pF=0.30, pE=0.55, pN=0.50)",
      trial: {
        shipBaseWeapon: 0, shipBaseHull: 3, shipFunds: 25000,
        attackerWeapon: 8, attackerHull: 12, attackerSpeed: 2, attackerKind: "rival_syndicate",
        pFight: 0.30, pFlee: 0.55, pNegotiate: 0.50,
        bribe: 5000, fightLossHull: 1, fleeLossHull: 0, fightLossCredits: 1250,
      },
    },
    {
      label: "fast scout vs slow pirate (pF=0.30, pE=0.85, pN=0.45)",
      trial: {
        shipBaseWeapon: 2, shipBaseHull: 5, shipFunds: 25000,
        attackerWeapon: 4, attackerHull: 6, attackerSpeed: 1, attackerKind: "pirate",
        pFight: 0.30, pFlee: 0.85, pNegotiate: 0.45,
        bribe: 3000, fightLossHull: 1, fleeLossHull: 0, fightLossCredits: 1250,
      },
    },
  ];
  const strategyResults: { label: string; trial: StrategyTrial; outcome: StrategyOutcome }[] = [];
  for (const p of profiles) {
    const o = runStrategyTrials(p.trial, TRIALS);
    strategyResults.push({ label: p.label, trial: p.trial, outcome: o });
    console.log(
      `${p.label.padEnd(64)}  fight w=${(o.fight.won / TRIALS * 100).toFixed(1)}%  flee e=${(o.flee.escaped / TRIALS * 100).toFixed(1)}%  neg p=${(o.negotiate.peace / TRIALS * 100).toFixed(1)}%`,
    );
  }

  console.log(`\n=== Encounter chance grid ===`);
  const grid = buildRateGrid();
  for (const e of grid) {
    console.log(
      `border=${e.isBorder ? "Y" : "N"}  hostile=${e.isHostile ? "Y" : "N"}  cargoVal=Ç${e.cargoValue.toLocaleString().padStart(7)}  → p=${(e.pSpawn * 100).toFixed(2)}%`,
    );
  }

  // Persist outputs
  for (const r of results) {
    const slug = r.config.label.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    writeFileSync(resolve(outDir, `world_${slug}.json`), JSON.stringify(r, null, 2));
  }
  writeFileSync(resolve(outDir, "world_summary.json"), JSON.stringify(
    results.map(r => ({
      label: r.config.label,
      config: r.config,
      ticks: r.ticks,
      totalEncounters: r.totalEncounters,
      playerEncounters: r.playerEncounters,
      npcEncounters: r.npcEncounters,
      pirateCount: r.pirateCount,
      rivalCount: r.rivalCount,
      borderEncounters: r.borderEncounters,
      hostileEncounters: r.hostileEncounters,
      outcomeCounts: r.outcomeCounts,
      choiceCounts: r.choiceCounts,
      laneHeatTop10: Object.entries(r.laneHeat).sort((a, b) => b[1] - a[1]).slice(0, 10),
      npcFleetWealthStart: r.npcFleetWealthStart,
      npcFleetWealthEnd: r.npcFleetWealthEnd,
      totalCreditDrain: r.totalCreditDrain,
      totalCargoUnitDrain: r.totalCargoUnitDrain,
      totalHullDrain: r.totalHullDrain,
      destroyedShips: r.destroyedShips,
      bucketsPer100Tick: r.bucketsPer100Tick,
      msPerTick: r.msPerTick,
    })),
    null, 2,
  ));
  writeFileSync(resolve(outDir, "strategy_results.json"), JSON.stringify(strategyResults, null, 2));
  writeFileSync(resolve(outDir, "rate_grid.json"), JSON.stringify(grid, null, 2));

  console.log(`\nwrote ${results.length + 3} files to ${outDir}/\n`);
}

main();
