import type { Trader, World } from "./types";
import { combinedShipModifiers, hasCrew, totalCrewWage } from "./crew";

export const MAINTENANCE_PER_CAPACITY = 0.5;
export const MAINTENANCE_IDLE_FACTOR = 0;
export const CREW_WAGES_PER_CAPACITY = 0;
export const DOCKING_FEE_PER_CAPACITY = 5;
export const SALES_TAX_RATE = 0.15;
export const STOCKPILE_CAP_MULT = 3.0;

export function productionScale(stock: number, target: number): number {
  if (target <= 0) return 1.0;
  if (stock >= target * STOCKPILE_CAP_MULT) return 0;
  if (stock <= target) return 1.0;
  return 1 - (stock - target) / (target * (STOCKPILE_CAP_MULT - 1));
}

function isPlayerShip(world: World, ship: Trader): boolean {
  return world.player?.shipIds.includes(ship.id) ?? false;
}

function maintenanceCost(trader: Trader): number {
  let cost = trader.capacity * CREW_WAGES_PER_CAPACITY;
  if (trader.state === "transit") {
    cost += trader.capacity * MAINTENANCE_PER_CAPACITY;
  } else {
    cost += trader.capacity * MAINTENANCE_PER_CAPACITY * MAINTENANCE_IDLE_FACTOR;
  }
  return cost;
}

export function chargeOperationalCosts(world: World): void {
  for (const trader of Object.values(world.traders)) {
    const cost = maintenanceCost(trader);
    if (cost <= 0) continue;

    if (isPlayerShip(world, trader)) {
      // Player ships: route maintenance through the mechanic gating, charge
      // crew wages on top — all from the ship's own wallet.
      const wages = totalCrewWage(trader);
      const mods = combinedShipModifiers(trader);
      const discount = mods.maintenanceDiscount ?? 0;
      const effectiveMaint = cost * (1 - discount);
      if (hasCrew(trader, "mechanic")) {
        // Mechanic auto-pays maintenance (alongside wages).
        const total = effectiveMaint + wages;
        trader.funds = Math.max(0, trader.funds - total);
      } else {
        // No mechanic — accumulate as visible debt; wages still charged.
        trader.maintenanceDebt = (trader.maintenanceDebt ?? 0) + effectiveMaint;
        if (wages > 0) trader.funds = Math.max(0, trader.funds - wages);
      }
      continue;
    }

    // NPC ships: legacy behavior — pay from their own funds, no debt path.
    if (trader.funds <= 0) continue;
    trader.funds = Math.max(0, trader.funds - cost);
  }
}

export function chargeDockingFee(trader: Trader): number {
  if (trader.funds <= 0) return 0;
  const fee = trader.capacity * DOCKING_FEE_PER_CAPACITY;
  const paid = Math.min(fee, trader.funds);
  trader.funds = Math.max(0, trader.funds - fee);
  return paid;
}

export const chargeMaintenance = chargeOperationalCosts;
