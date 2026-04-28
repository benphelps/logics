// Player-progression audit. Simulate a player ship under best-case conditions
// (auto-pilot + captain hired immediately, mechanic + navigator soon after) and
// observe their wealth trajectory next to the NPC fleet's. Tells us whether
// the player can compete in the late game.

import { createWorld } from "../world";
import { generateWorld } from "../gen/world";
import { tickWorld } from "../tick";
import { hireCrew } from "../crew";
import { repairShip } from "../traders";
import type { World } from "../types";

const HORIZON = Number(process.argv[2] ?? 5000);
const SAMPLE_INTERVAL = Math.max(50, Math.floor(HORIZON / 30));

interface Sample {
  tick: number;
  playerFunds: number;
  playerCargoValue: number;
  npcTotalFunds: number;
  npcCount: number;
  jobsCompleted: number;
  jobsExpired: number;
  hires: number;
  pilotHired: boolean;
  mechanicHired: boolean;
  navigatorHired: boolean;
  maintenanceDebt: number;
}

function totalCargoValue(world: World, traderId: string): number {
  const t = world.traders[traderId];
  if (!t) return 0;
  let v = 0;
  for (const lot of t.cargo) v += lot.qty * (world.goods[lot.good]?.basePrice ?? 0);
  return v;
}

function tryHireRole(world: World, shipId: string, role: "captain" | "mechanic" | "navigator", maxCost: number): boolean {
  const ship = world.traders[shipId];
  if (!ship) return false;
  if (ship.crew?.[role]) return true;
  // Look for a hire offer at this station for this role
  const candidates = Object.values(world.hires).filter(h => h.role === role && h.location === ship.location && h.hireCost <= ship.funds && h.hireCost <= maxCost);
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => a.hireCost - b.hireCost);
  return hireCrew(world, ship, candidates[0].id).ok;
}

function audit(world: World, label: string, ticks: number): Sample[] {
  const playerId = world.player!.shipIds[0];
  const ship = world.traders[playerId];
  ship.pilot = "auto";
  // We'll let the bot hire a captain ASAP

  const samples: Sample[] = [];
  let jobsCompleted = 0;
  let jobsExpired = 0;
  for (let i = 0; i < ticks; i++) {
    // If maintenance debt is high, repair when possible
    if ((ship.maintenanceDebt ?? 0) > 5_000 && ship.state === "idle" && ship.funds > (ship.maintenanceDebt ?? 0)) {
      repairShip(world, ship);
    }
    // Try hires when at a station
    if (ship.state === "idle") {
      tryHireRole(world, playerId, "captain", 300_000);
      tryHireRole(world, playerId, "mechanic", 200_000);
      tryHireRole(world, playerId, "navigator", 200_000);
    }
    const r = tickWorld(world);
    jobsExpired += r.jobsExpired.length;
    if ((i + 1) % SAMPLE_INTERVAL === 0 || i === ticks - 1) {
      const npcFunds = Object.values(world.traders).filter(t => t.id !== playerId).reduce((s, t) => s + t.funds, 0);
      jobsCompleted = (ship.log ?? []).filter(e => e.kind === "job_completed").length;
      samples.push({
        tick: world.tick,
        playerFunds: ship.funds,
        playerCargoValue: totalCargoValue(world, playerId),
        npcTotalFunds: npcFunds,
        npcCount: Object.keys(world.traders).length - 1,
        jobsCompleted,
        jobsExpired,
        hires: Object.keys(world.hires).length,
        pilotHired: !!ship.crew?.captain,
        mechanicHired: !!ship.crew?.mechanic,
        navigatorHired: !!ship.crew?.navigator,
        maintenanceDebt: ship.maintenanceDebt ?? 0,
      });
    }
  }
  void label;
  return samples;
}

function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

function printReport(label: string, samples: Sample[]): void {
  console.log(`\n━━━ ${label} ━━━`);
  console.log(`  tick      player    p+cargo    npcFleet  ratio  cap mec nav  jobs   debt`);
  for (const s of samples) {
    const playerTotal = s.playerFunds + s.playerCargoValue;
    const ratio = s.npcTotalFunds > 0 ? playerTotal / (s.npcTotalFunds / s.npcCount) : 0;
    const cap = s.pilotHired ? "y" : ".";
    const mec = s.mechanicHired ? "y" : ".";
    const nav = s.navigatorHired ? "y" : ".";
    console.log(
      `  ${String(s.tick).padStart(6)}  ${fmtMoney(s.playerFunds).padStart(8)}  ${fmtMoney(playerTotal).padStart(8)}  ${fmtMoney(s.npcTotalFunds).padStart(8)}  ${ratio.toFixed(2).padStart(5)}  ${cap}   ${mec}   ${nav}  ${String(s.jobsCompleted).padStart(4)}  ${fmtMoney(s.maintenanceDebt).padStart(6)}`
    );
  }
  console.log(`  ratio: player_total / avg_npc_funds`);
}

console.log(`\n=== Player progression audit ===\nhorizon=${HORIZON}\n`);

{
  const w = createWorld();
  const samples = audit(w, "starter universe + player auto-pilot", HORIZON);
  printReport("starter universe + player auto-pilot", samples);
}

{
  const w = generateWorld({ seed: 42, locationCount: 12, traderCount: 18 });
  // Need to add a player ship explicitly
  const made = (await import("../data/player")).makePlayer({ startingFunds: 55_000, startingLocation: Object.keys(w.locations)[0], startingShipName: "Voyager" });
  w.traders[made.ship.id] = made.ship;
  w.player = made.player;
  const samples = audit(w, "12-loc generated + player auto-pilot", HORIZON);
  printReport("12-loc generated + player auto-pilot", samples);
}
