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

export interface CargoGroup {
  good: GoodId;
  lots: CargoLot[];
  totalQty: number;
  totalCost: number;          // sum of lot.qty * lot.unitPrice
  weightedAvgPrice: number;   // totalCost / totalQty
  oldestPurchasedAt: number;  // for "age" display
  sources: Set<string>;       // distinct source locations
}

export function groupCargoByGood(trader: Trader): CargoGroup[] {
  const map = new Map<GoodId, CargoGroup>();
  for (const lot of trader.cargo) {
    let g = map.get(lot.good);
    if (!g) {
      g = {
        good: lot.good,
        lots: [],
        totalQty: 0,
        totalCost: 0,
        weightedAvgPrice: 0,
        oldestPurchasedAt: lot.purchasedAt,
        sources: new Set(),
      };
      map.set(lot.good, g);
    }
    g.lots.push(lot);
    g.totalQty += lot.qty;
    g.totalCost += lot.qty * lot.unitPrice;
    g.oldestPurchasedAt = Math.min(g.oldestPurchasedAt, lot.purchasedAt);
    g.sources.add(lot.source);
  }
  for (const g of map.values()) {
    g.weightedAvgPrice = g.totalQty > 0 ? g.totalCost / g.totalQty : 0;
  }
  return Array.from(map.values());
}
