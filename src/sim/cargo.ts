import type { CargoLot, GoodId, Trader, World } from "./types";

export function cargoMass(trader: Trader, world: World): number {
  let m = 0;
  for (const lot of trader.cargo) m += lot.qty * (world.goods[lot.good]?.weight ?? 0);
  // unloadingCargo is still physically aboard until the drip moves each
  // fraction off-ship, so it counts toward mass for display + capacity checks.
  for (const lot of trader.unloadingCargo ?? []) m += lot.qty * (world.goods[lot.good]?.weight ?? 0);
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
  lots: CargoLot[];           // lots still in the active hold (sellable, travelable)
  totalQty: number;           // sum of in-hold lot qty (does NOT include unloadingQty)
  totalCost: number;          // sum of lot.qty * lot.unitPrice (in-hold only)
  weightedAvgPrice: number;   // totalCost / totalQty (in-hold only)
  oldestPurchasedAt: number;  // for "age" display
  sources: Set<string>;       // distinct source locations across both buckets
  unloadingQty: number;       // qty of this good currently dripping into the dest market
}

export function groupCargoByGood(trader: Trader): CargoGroup[] {
  const map = new Map<GoodId, CargoGroup>();
  const ensure = (good: GoodId, purchasedAt: number): CargoGroup => {
    let g = map.get(good);
    if (!g) {
      g = {
        good,
        lots: [],
        totalQty: 0,
        totalCost: 0,
        weightedAvgPrice: 0,
        oldestPurchasedAt: purchasedAt,
        sources: new Set(),
        unloadingQty: 0,
      };
      map.set(good, g);
    }
    return g;
  };

  for (const lot of trader.cargo) {
    const g = ensure(lot.good, lot.purchasedAt);
    g.lots.push(lot);
    g.totalQty += lot.qty;
    g.totalCost += lot.qty * lot.unitPrice;
    g.oldestPurchasedAt = Math.min(g.oldestPurchasedAt, lot.purchasedAt);
    g.sources.add(lot.source);
  }
  for (const lot of trader.unloadingCargo ?? []) {
    const g = ensure(lot.good, lot.purchasedAt);
    g.unloadingQty += lot.qty;
    g.oldestPurchasedAt = Math.min(g.oldestPurchasedAt, lot.purchasedAt);
    g.sources.add(lot.source);
  }
  for (const g of map.values()) {
    g.weightedAvgPrice = g.totalQty > 0 ? g.totalCost / g.totalQty : 0;
  }
  return Array.from(map.values());
}
