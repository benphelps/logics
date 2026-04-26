import type { World } from "./types";

export const MAINTENANCE_PER_CAPACITY = 1.5;
export const MAINTENANCE_IDLE_FACTOR = 0.4;
export const STOCKPILE_CAP_MULT = 3.0;

export function productionScale(stock: number, target: number): number {
  if (target <= 0) return 1.0;
  if (stock >= target * STOCKPILE_CAP_MULT) return 0;
  if (stock <= target) return 1.0;
  return 1 - (stock - target) / (target * (STOCKPILE_CAP_MULT - 1));
}

export function chargeMaintenance(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.funds <= 0) continue;
    const factor = trader.state === "transit" ? 1.0 : MAINTENANCE_IDLE_FACTOR;
    const cost = trader.capacity * MAINTENANCE_PER_CAPACITY * factor;
    trader.funds = Math.max(0, trader.funds - cost);
  }
}
