import type { CrewMember, CrewModifiers, CrewRole, HireId, ShipCrew, Trader, World } from "./types";
import { snapshotFromHire, takeHire } from "./hires";

// Maintenance debt accrued for player ships without a mechanic. Once debt
// crosses this threshold, the ship can't depart until repaired. Sized so
// the player has runway to reach the (new, cheaper) mechanic baseline of
// Ç40k before being grounded.
export const MAINTENANCE_DEBT_TRAVEL_BLOCK = 8_000;

// --- modifier folding ------------------------------------------------------

export function combinedModifiers(crew: ShipCrew | undefined): CrewModifiers {
  const acc: CrewModifiers = {};
  if (!crew) return acc;
  for (const member of Object.values(crew)) {
    if (!member) continue;
    const m = member.modifiers;
    if (m.cargoCapacityBonus)    acc.cargoCapacityBonus    = (acc.cargoCapacityBonus ?? 0)    + m.cargoCapacityBonus;
    if (m.fuelCapacityBonus)     acc.fuelCapacityBonus     = (acc.fuelCapacityBonus ?? 0)     + m.fuelCapacityBonus;
    if (m.speedBonus)            acc.speedBonus            = (acc.speedBonus ?? 0)            + m.speedBonus;
    if (m.rangeEfficiency)       acc.rangeEfficiency       = (acc.rangeEfficiency ?? 0)       + m.rangeEfficiency;
    if (m.buyDiscount)           acc.buyDiscount           = (acc.buyDiscount ?? 0)           + m.buyDiscount;
    if (m.sellPremium)           acc.sellPremium           = (acc.sellPremium ?? 0)           + m.sellPremium;
    if (m.maintenanceDiscount)   acc.maintenanceDiscount   = (acc.maintenanceDiscount ?? 0)   + m.maintenanceDiscount;
    if (m.contractRewardBonus)   acc.contractRewardBonus   = (acc.contractRewardBonus ?? 0)   + m.contractRewardBonus;
  }
  return acc;
}

// Recompute the ship's effective stats from base stats + crew modifiers.
// Idempotent — call after any hire/fire. Initializes base* on first call so
// existing fixtures (which don't set base*) lock in their starting values.
export function recomputeShipStats(ship: Trader): void {
  if (ship.baseCapacity == null)     ship.baseCapacity = ship.capacity;
  if (ship.baseSpeed == null)        ship.baseSpeed = ship.speed;
  if (ship.baseFuelCapacity == null) ship.baseFuelCapacity = ship.fuelCapacity;

  const mods = combinedModifiers(ship.crew);
  ship.capacity     = ship.baseCapacity     + (mods.cargoCapacityBonus ?? 0);
  ship.fuelCapacity = ship.baseFuelCapacity + (mods.fuelCapacityBonus ?? 0);
  ship.speed        = ship.baseSpeed        + (mods.speedBonus ?? 0);

  // Cap currentFuel at the new capacity (in case of fire-then-rehire).
  if (ship.currentFuel && ship.currentFuel.qty > ship.fuelCapacity) {
    ship.currentFuel.qty = ship.fuelCapacity;
  }
}

// rangeEfficiency stacks per-fuel — a 10% efficiency reduces perDistance by
// 10%. Read from this helper rather than mutating fuelTypes so the ship's
// declared fuel cost stays untouched.
export function effectivePerDistance(ship: Trader, basePerDistance: number): number {
  const mods = combinedModifiers(ship.crew);
  const eff = mods.rangeEfficiency ?? 0;
  return basePerDistance * Math.max(0.1, 1 - eff);
}

// --- hire / fire actions ---------------------------------------------------

export type CrewActionResult = { ok: true } | { ok: false; reason: string };

// Hire from a posted offer. The offer must be at the ship's current station
// (you can only sign someone on while you're docked together). On success
// the offer is consumed from world.hires.
export function hireCrew(world: World, ship: Trader, hireId: HireId): CrewActionResult {
  if (ship.state !== "idle") return { ok: false, reason: "Can only hire while docked." };
  if (!world.player) return { ok: false, reason: "No player." };
  if (!world.player.shipIds.includes(ship.id)) return { ok: false, reason: "Crew is a player-only system." };
  const offer = world.hires[hireId];
  if (!offer) return { ok: false, reason: "Offer no longer available." };
  if (offer.location !== ship.location) return { ok: false, reason: "That offer is at a different station." };
  if (world.player.funds < offer.hireCost) {
    return { ok: false, reason: `Need Ç${offer.hireCost.toLocaleString()}, have Ç${Math.round(world.player.funds).toLocaleString()}.` };
  }

  world.player.funds -= offer.hireCost;
  ship.crew = ship.crew ?? {};
  ship.crew[offer.role] = snapshotFromHire(offer);
  takeHire(world, hireId);            // consume the offer
  recomputeShipStats(ship);
  return { ok: true };
}

export function fireCrew(ship: Trader, role: CrewRole): CrewActionResult {
  if (ship.state !== "idle") return { ok: false, reason: "Can only fire while docked." };
  if (!ship.crew?.[role]) return { ok: false, reason: `No ${role} on this ship.` };
  delete ship.crew[role];
  recomputeShipStats(ship);
  return { ok: true };
}

export function hasCrew(ship: Trader, role: CrewRole): boolean {
  return ship.crew?.[role] != null;
}

// --- ongoing wage charging -------------------------------------------------

// Sum of all crew wages on this ship (per tick). Used by the maintenance
// pass — wages are deducted alongside (or in place of) maintenance.
export function totalCrewWage(ship: Trader): number {
  if (!ship.crew) return 0;
  let s = 0;
  for (const m of Object.values(ship.crew)) if (m) s += m.wagePerTick;
  return s;
}
