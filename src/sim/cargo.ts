import type { CargoLot, GoodId, Trader, World } from "./types";

export function cargoMass(trader: Trader, world: World): number {
  let m = 0;
  for (const lot of trader.cargo) {
    m += lot.qty * (world.goods[lot.good]?.weight ?? 0);
  }
  return m;
}

export function cargoSpace(trader: Trader, world: World): number {
  return Math.max(0, trader.capacity - cargoMass(trader, world));
}

export function findCargoLot(trader: Trader, good: GoodId): CargoLot | undefined {
  return trader.cargo.find(l => l.good === good);
}

export function totalCargoUnits(trader: Trader): number {
  let n = 0;
  for (const lot of trader.cargo) n += lot.qty;
  return n;
}
