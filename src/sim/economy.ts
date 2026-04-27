import type { Trader, World } from "./types";

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

export function chargeOperationalCosts(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.funds <= 0) continue;
    let cost = trader.capacity * CREW_WAGES_PER_CAPACITY;
    if (trader.state === "transit") {
      cost += trader.capacity * MAINTENANCE_PER_CAPACITY;
    } else {
      cost += trader.capacity * MAINTENANCE_PER_CAPACITY * MAINTENANCE_IDLE_FACTOR;
    }
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
