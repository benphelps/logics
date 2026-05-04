// Phase 1 combat encounter system. Probabilistic threats during transit
// resolved via odds rather than per-turn fighting. Manual ships pause for
// player input via world.pendingEncounter; auto ships resolve via
// autopilotPolicy. NPC-on-NPC encounters are out of scope for Phase 1.

import type {
  Encounter,
  EncounterAttacker,
  EncounterChoice,
  EncounterKind,
  EncounterLoss,
  EncounterOutcome,
  GoodId,
  OddsBand,
  Trader,
  World,
} from "../types";
import { mulberry32, pick, rangeFloat, type Rng } from "../gen/rng";
import { eventMultiplier } from "../news/modifier";

// --- tunables ------------------------------------------------------------

export const BASE_ENCOUNTER_CHANCE = 0.05;
export const MIN_ENCOUNTER_CHANCE = 0.03;
export const MAX_ENCOUNTER_CHANCE = 0.07;
const BORDER_BONUS = 0.015;
const HOSTILE_BONUS = 0.015;
const CARGO_VALUE_BONUS_PER_CREDIT = 4e-7;

// Per-ship cooldown after a spawn so the player can't get jumped on
// consecutive transit ticks. Also avoids the worst-case "two encounters in a
// 3-tick lane" frustration.
export const ENCOUNTER_COOLDOWN_TICKS = 8;

export const ENCOUNTER_HISTORY_CAP = 200;

const FIGHT_LOSS_CARGO_MASS_FRACTION = 0.30;
const NEGOTIATE_PARTIAL_FRACTION = 0.12;
const FIGHT_LOSS_CREDIT_FRACTION = 0.05;
const FIGHT_LOSS_CREDIT_CARGO_FRACTION = 0.02;
const NEGOTIATE_BRIBE_BASE = 1500;
const NEGOTIATE_BRIBE_PER_CARGO_VALUE = 0.04;
const FIGHT_LOSS_HULL_FRACTION_OF_BASE = 0.25;
const FLEE_LOSS_HULL_FRACTION_OF_BASE = 0.10;

const REP_NEGOTIATE_BONUS = 0.40;
const REP_PEACE_GAIN = 0.04;
const REP_HOSTILE_LOSS = 0.06;

// Autopilot thresholds — mercenary aboard fights more readily, otherwise
// favors flee with negotiate as a budget-friendly fallback.
const AUTO_FIGHT_MIN_P = 0.55;
const AUTO_NEGOTIATE_MIN_P = 0.50;

// --- public API ----------------------------------------------------------

// Roll for an encounter on the current transit tick. Returns the constructed
// Encounter (already stamped with id) when it fires, otherwise null. Caller
// is responsible for assigning the encounter to world.pendingEncounter or
// resolving in-place via resolveEncounter.
export function maybeSpawnEncounter(world: World, ship: Trader): Encounter | null {
  if (ship.state !== "transit") return null;
  if (!ship.destination) return null;

  const lastTick = ship.lastEncounterTick ?? Number.NEGATIVE_INFINITY;
  if (world.tick - lastTick < ENCOUNTER_COOLDOWN_TICKS) return null;

  const p = encounterChance(world, ship);
  const rng = rngFor(world, ship.id, "spawn");
  if (rng() >= p) return null;

  const attacker = generateAttacker(world, ship, rng);
  const cargoValue = totalCargoValueOf(ship, world);

  const fightLoss = computeFightLoss(world, ship, cargoValue);
  const fleeLoss = computeFleeLoss(ship);
  const partialCargo = computePartialCargoLoss(world, ship);
  const bribe = computeBribe(cargoValue);

  const pFight = computePFight(ship, attacker);
  const pFlee = computePFlee(ship, attacker);
  const pNegotiate = computePNegotiate(world, ship, attacker);

  const id = `enc-${world.nextEncounterId ?? 1}`;
  world.nextEncounterId = (world.nextEncounterId ?? 1) + 1;
  ship.lastEncounterTick = world.tick;

  return {
    id,
    spawnedAt: world.tick,
    shipId: ship.id,
    fromLocation: ship.location,
    toLocation: ship.destination,
    attacker,
    pFight,
    pFlee,
    pNegotiate,
    oddsFight: oddsBandFor(pFight),
    oddsFlee: oddsBandFor(pFlee),
    oddsNegotiate: oddsBandFor(pNegotiate),
    fightLossOnFail: fightLoss,
    fleeLossOnFail: fleeLoss,
    negotiateBribe: bribe,
    negotiatePartialCargo: partialCargo,
  };
}

// Resolve an encounter with the given choice. Mutates ship.cargo / funds /
// hull. Stamps encounter.resolution. Caller appends the encounter to
// world.encounterHistory and emits log entries.
export function resolveEncounter(
  world: World,
  ship: Trader,
  encounter: Encounter,
  choice: EncounterChoice,
  autoResolved: boolean,
): EncounterOutcome {
  const rng = rngFor(world, ship.id, `resolve:${encounter.id}`);
  let outcome: EncounterOutcome;
  let appliedLoss: EncounterLoss | undefined;

  if (choice === "fight") {
    if (rng() < encounter.pFight) {
      outcome = "won";
    } else {
      outcome = "lost";
      appliedLoss = applyLoss(ship, encounter.fightLossOnFail);
    }
  } else if (choice === "flee") {
    if (rng() < encounter.pFlee) {
      outcome = "escaped";
    } else {
      outcome = "fled_damaged";
      appliedLoss = applyLoss(ship, encounter.fleeLossOnFail);
    }
  } else {
    // negotiate
    if (ship.funds < encounter.negotiateBribe) {
      // Can't afford bribe — encounter falls through to a fight-loss outcome.
      outcome = "negotiated_fail";
      appliedLoss = applyLoss(ship, encounter.fightLossOnFail);
    } else if (rng() < encounter.pNegotiate) {
      ship.funds -= encounter.negotiateBribe;
      if (encounter.attacker.kind === "rival_syndicate") {
        outcome = "negotiated_peace";
        appliedLoss = { credits: encounter.negotiateBribe, cargo: [], hull: 0 };
      } else {
        const cargoTaken = removeCargo(ship, encounter.negotiatePartialCargo);
        outcome = "negotiated_partial";
        appliedLoss = { credits: encounter.negotiateBribe, cargo: cargoTaken, hull: 0 };
      }
    } else {
      ship.funds -= encounter.negotiateBribe;
      const fightApplied = applyLoss(ship, encounter.fightLossOnFail);
      outcome = "negotiated_fail";
      appliedLoss = {
        credits: encounter.negotiateBribe + fightApplied.credits,
        cargo: fightApplied.cargo,
        hull: fightApplied.hull,
      };
    }
  }

  encounter.resolution = {
    choice,
    outcome,
    tick: world.tick,
    loss: appliedLoss,
    autoResolved,
  };

  // Reputation: peace with a rival nudges up, violence nudges down.
  // Pirates have no syndicate, so rep is untouched.
  if (encounter.attacker.kind === "rival_syndicate" && encounter.attacker.syndicateId && world.player) {
    const rep = world.player.reputation ?? (world.player.reputation = {});
    const sid = encounter.attacker.syndicateId;
    const cur = rep[sid] ?? 0;
    if (outcome === "negotiated_peace") {
      rep[sid] = Math.min(1, cur + REP_PEACE_GAIN);
    } else if (outcome === "won" || outcome === "lost" || outcome === "negotiated_fail") {
      rep[sid] = Math.max(0, cur - REP_HOSTILE_LOSS);
    }
  }

  return outcome;
}

// Decide which choice the autopilot would pick — also used as a hint in the
// manual modal ("recommended").
export function autopilotPolicy(ship: Trader, encounter: Encounter): EncounterChoice {
  const hasMerc = !!ship.crew?.mercenary;
  if (hasMerc && encounter.pFight >= AUTO_FIGHT_MIN_P) return "fight";
  if (encounter.pNegotiate >= AUTO_NEGOTIATE_MIN_P && ship.funds >= encounter.negotiateBribe) return "negotiate";
  return "flee";
}

// Append a resolved encounter to history (capped). Used by both manual + auto
// resolution paths so the bookkeeping is consistent.
export function recordEncounter(world: World, encounter: Encounter): void {
  if (!world.encounterHistory) world.encounterHistory = [];
  world.encounterHistory.push(encounter);
  if (world.encounterHistory.length > ENCOUNTER_HISTORY_CAP) {
    world.encounterHistory.splice(0, world.encounterHistory.length - ENCOUNTER_HISTORY_CAP);
  }
}

// Convenience wrapper for the store: resolves world.pendingEncounter with the
// player's choice, applies the loss, records it, and clears the pending slot.
// Returns the encounter (now with `resolution` stamped) or null if there
// wasn't one. Caller is responsible for any UI-side log entry — sim-side
// callers should use the path in traders.ts which writes to ship.log directly.
export function resolvePendingEncounter(
  world: World,
  choice: EncounterChoice,
): Encounter | null {
  const enc = world.pendingEncounter;
  if (!enc) return null;
  const ship = world.traders[enc.shipId];
  if (!ship) {
    world.pendingEncounter = undefined;
    return null;
  }
  resolveEncounter(world, ship, enc, choice, false);
  recordEncounter(world, enc);
  world.pendingEncounter = undefined;
  return enc;
}

// --- triggering ----------------------------------------------------------

export function encounterChance(world: World, ship: Trader): number {
  if (!ship.destination) return 0;
  const fromSynd = world.locations[ship.location]?.traits.faction;
  const toSynd = world.locations[ship.destination]?.traits.faction;
  const ownSynd = ship.syndicateId;
  const isBorder = fromSynd !== toSynd;
  const isHostile = !!ownSynd && !!toSynd && toSynd !== ownSynd;

  let p = BASE_ENCOUNTER_CHANCE;
  if (isBorder) p += BORDER_BONUS;
  if (isHostile) p += HOSTILE_BONUS;

  const cargoValue = totalCargoValueOf(ship, world);
  p += cargoValue * CARGO_VALUE_BONUS_PER_CREDIT;

  // News modulation. Resolves to 1 when no active templates touch the scope.
  p *= eventMultiplier(world, "encounter_chance", {
    locationId: ship.destination ?? undefined,
    syndicateId: ownSynd,
  });

  return clamp(p, MIN_ENCOUNTER_CHANCE, MAX_ENCOUNTER_CHANCE);
}

function rngFor(world: World, shipId: string, salt: string): Rng {
  const idHash = hashStr(shipId) ^ hashStr(salt);
  const next = world.nextEncounterId ?? 1;
  const seed = (((world.tick + 1) * 0x9e3779b9) ^ idHash ^ (next * 0x6d2b79f5)) | 0;
  return mulberry32(seed);
}

function hashStr(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

// --- attacker generation -------------------------------------------------

const PIRATE_NAMES: readonly string[] = [
  "Carrion Vow", "Splintered Axiom", "Bone Ledger",
  "Heretic Star", "Vagrant Hex", "Thresher's Promise",
  "Black Aubade", "Slow Verdict", "Saltbreaker",
  "Cinderhound", "Pale Obol", "Quietus",
  "Ash Privateer", "Rust Catechism", "Lonely Tariff",
];

const RIVAL_NAMES: readonly string[] = [
  "Cordon Vexil", "Iron Argument", "Marshal Quorum",
  "Tax Writ Nine", "Border Lance", "Articulus VII",
  "Strait Edict", "Fenline Patrol", "Charter Echo",
  "Trapezium", "Bonded Witness", "Pursuant",
];

function generateAttacker(world: World, ship: Trader, rng: Rng): EncounterAttacker {
  const ownSynd = ship.syndicateId;
  const toSynd = ship.destination ? world.locations[ship.destination]?.traits.faction : undefined;
  const playerRep = world.player?.reputation ?? {};
  const repWithDest = toSynd ? (playerRep[toSynd] ?? 0) : 0;

  // Rival-syndicate attackers only show up when the player is foreign at the
  // destination AND their reputation with the destination's syndicate is low.
  // High reputation = rivals don't bother you. Pirates fill the gap otherwise.
  const canRival = !!ownSynd && !!toSynd && toSynd !== ownSynd && repWithDest < 0.4;
  const isRival = canRival && rng() < 0.35;

  const baseWeapon = ship.weaponPower ?? ship.baseWeaponPower ?? 1;
  const baseHull = ship.hull ?? ship.baseHull ?? 1;

  const wScale = isRival ? rangeFloat(rng, 0.85, 1.45) : rangeFloat(rng, 0.55, 1.30);
  const hScale = isRival ? rangeFloat(rng, 0.90, 1.40) : rangeFloat(rng, 0.60, 1.20);
  const sScale = rangeFloat(rng, 0.80, 1.20);

  const weaponPower = Math.max(1, Math.round(baseWeapon * wScale + rangeFloat(rng, 0, 6)));
  const hull = Math.max(1, Math.round(baseHull * hScale + rangeFloat(rng, 0, 8)));
  const speed = Math.max(2, Math.round(ship.speed * sScale));
  const crewLevel = isRival ? rangeFloat(rng, 0.45, 0.85) : rangeFloat(rng, 0.20, 0.70);

  const kind: EncounterKind = isRival ? "rival_syndicate" : "pirate";
  return {
    name: pick(rng, isRival ? RIVAL_NAMES : PIRATE_NAMES),
    kind,
    syndicateId: isRival ? toSynd : undefined,
    weaponPower,
    hull,
    speed,
    crewLevel,
  };
}

// --- odds math -----------------------------------------------------------

function computePFight(ship: Trader, attacker: EncounterAttacker): number {
  const merc = ship.crew?.mercenary;
  const mercTier = merc?.tier ?? 0;
  const power = (ship.weaponPower ?? ship.baseWeaponPower ?? 0) + mercTier * 4;
  const delta = power - attacker.weaponPower;
  return clamp01(0.50 + 0.40 * Math.tanh(delta / 8));
}

function computePFlee(ship: Trader, attacker: EncounterAttacker): number {
  const delta = ship.speed - attacker.speed;
  return clamp01(0.55 + 0.40 * Math.tanh(delta / 4));
}

function computePNegotiate(world: World, _ship: Trader, attacker: EncounterAttacker): number {
  if (attacker.kind === "pirate") {
    return 0.45;
  }
  const sid = attacker.syndicateId;
  const rep = sid && world.player?.reputation ? world.player.reputation[sid] ?? 0 : 0;
  return clamp01(0.30 + REP_NEGOTIATE_BONUS * rep);
}

function oddsBandFor(p: number): OddsBand {
  if (p >= 0.80) return "very_likely";
  if (p >= 0.60) return "likely";
  if (p >= 0.40) return "even";
  if (p >= 0.20) return "risky";
  return "longshot";
}

// --- losses --------------------------------------------------------------

function totalCargoMassOf(ship: Trader, world: World): number {
  let m = 0;
  for (const lot of ship.cargo) m += lot.qty * (world.goods[lot.good]?.weight ?? 0);
  return m;
}

function totalCargoValueOf(ship: Trader, world: World): number {
  let v = 0;
  const market = world.markets[ship.destination ?? ship.location];
  for (const lot of ship.cargo) {
    const price = market?.prices[lot.good] ?? lot.unitPrice ?? 0;
    v += lot.qty * price;
  }
  return v;
}

// Pick cargo to surrender, lightest goods first (q4). Coalesces results
// across multiple lots of the same good so the modal reads cleanly.
export function selectCargoLossLightFirst(
  ship: Trader,
  world: World,
  targetMass: number,
): { good: GoodId; qty: number }[] {
  if (targetMass <= 0 || ship.cargo.length === 0) return [];
  const sorted = [...ship.cargo].sort((a, b) => {
    const wa = world.goods[a.good]?.weight ?? 0;
    const wb = world.goods[b.good]?.weight ?? 0;
    return wa - wb;
  });
  const out = new Map<GoodId, number>();
  let remaining = targetMass;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const w = world.goods[lot.good]?.weight ?? 0;
    if (w <= 0) continue;
    const lotMass = lot.qty * w;
    if (lotMass <= remaining) {
      out.set(lot.good, (out.get(lot.good) ?? 0) + lot.qty);
      remaining -= lotMass;
    } else {
      // Undershoot rather than overshoot: when the remaining budget can't
      // cover a full unit, take none of this good and move on. Player-friendly
      // — losses round down, not up.
      const qty = Math.floor(remaining / w);
      if (qty > 0) out.set(lot.good, (out.get(lot.good) ?? 0) + qty);
      remaining = 0;
    }
  }
  return [...out.entries()].map(([good, qty]) => ({ good, qty }));
}

function computeFightLoss(world: World, ship: Trader, cargoValue: number): EncounterLoss {
  const cargoMass = totalCargoMassOf(ship, world);
  const targetMass = Math.floor(cargoMass * FIGHT_LOSS_CARGO_MASS_FRACTION);
  const cargo = selectCargoLossLightFirst(ship, world, targetMass);
  const credits = Math.round(Math.min(
    ship.funds,
    ship.funds * FIGHT_LOSS_CREDIT_FRACTION + cargoValue * FIGHT_LOSS_CREDIT_CARGO_FRACTION,
  ));
  const baseHull = ship.baseHull ?? ship.hull ?? 30;
  const hull = Math.round(baseHull * FIGHT_LOSS_HULL_FRACTION_OF_BASE);
  return { credits, cargo, hull };
}

function computeFleeLoss(ship: Trader): EncounterLoss {
  const baseHull = ship.baseHull ?? ship.hull ?? 30;
  const hull = Math.round(baseHull * FLEE_LOSS_HULL_FRACTION_OF_BASE);
  return { credits: 0, cargo: [], hull };
}

function computePartialCargoLoss(world: World, ship: Trader): { good: GoodId; qty: number }[] {
  const cargoMass = totalCargoMassOf(ship, world);
  const target = Math.floor(cargoMass * NEGOTIATE_PARTIAL_FRACTION);
  return selectCargoLossLightFirst(ship, world, target);
}

function computeBribe(cargoValue: number): number {
  return Math.round(NEGOTIATE_BRIBE_BASE + cargoValue * NEGOTIATE_BRIBE_PER_CARGO_VALUE);
}

// --- application ---------------------------------------------------------

function applyLoss(ship: Trader, loss: EncounterLoss): EncounterLoss {
  const credits = Math.min(ship.funds, loss.credits);
  ship.funds -= credits;
  const cargo = removeCargo(ship, loss.cargo);
  const baseHull = ship.baseHull ?? ship.hull ?? 1;
  const hullDamage = Math.min(ship.hull ?? baseHull, loss.hull);
  ship.hull = (ship.hull ?? baseHull) - hullDamage;
  return { credits, cargo, hull: hullDamage };
}

function removeCargo(ship: Trader, requested: { good: GoodId; qty: number }[]): { good: GoodId; qty: number }[] {
  const taken = new Map<GoodId, number>();
  for (const want of requested) {
    let remaining = want.qty;
    for (const lot of ship.cargo) {
      if (remaining <= 0) break;
      if (lot.good !== want.good) continue;
      const give = Math.min(lot.qty, remaining);
      lot.qty -= give;
      remaining -= give;
      taken.set(want.good, (taken.get(want.good) ?? 0) + give);
    }
  }
  ship.cargo = ship.cargo.filter(l => l.qty > 0.001);
  return [...taken.entries()].map(([good, qty]) => ({ good, qty }));
}

// --- helpers -------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
