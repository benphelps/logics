import type { GoodId, LocationId, Trader, World } from "./types";
import { reachableNeighbors } from "./geometry";
import { priceFor } from "./pricing";
import { activeFuelType, listTradeOptions, selectRefuelType } from "./traders";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "./economy";

export type GuidedHint =
  | { kind: "buy_for_route"; good: GoodId; qty: number; dst: LocationId; netProfit: number; ticks: number; profitPerTick: number }
  | { kind: "travel_to_sell"; dst: LocationId; good: GoodId; qty: number; expectedNet: number; gainOverHere: number; ticks: number }
  | { kind: "sell_here"; good: GoodId; qty: number; revenue: number }
  | { kind: "refuel"; critical: boolean; reason: string }
  | { kind: "wait"; reason: string };

const FUEL_LOW_FRACTION = 0.25;
const FUEL_CRITICAL_FRACTION = 0.10;

export function getGuidedHint(world: World, ship: Trader): GuidedHint {
  if (ship.state === "transit") {
    return { kind: "wait", reason: `In transit to ${world.locations[ship.destination!]?.name ?? ship.destination}.` };
  }

  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;

  // Critical fuel + fuel for sale here → refuel right now (override everything)
  if (fuel && ft) {
    const fraction = fuel.qty / ship.fuelCapacity;
    const altFuelAvailable = selectRefuelType(world, ship) != null;

    if (fraction < FUEL_CRITICAL_FRACTION && altFuelAvailable) {
      return { kind: "refuel", critical: true, reason: `Tank at ${(fraction * 100).toFixed(0)}% — refuel before any move.` };
    }
    // No fuel + no fuel here → stuck
    if (fuel.qty <= 0.001 && !altFuelAvailable) {
      return { kind: "wait", reason: "Out of fuel and no compatible fuel for sale here. Wait for a trader to bring some, or summon help." };
    }
  }

  if (ship.cargo) {
    return cargoLoadedHint(world, ship);
  }

  // Empty cargo: best buy-and-travel
  const opts = listTradeOptions(world, ship);
  const top = opts[0];
  if (top) {
    return {
      kind: "buy_for_route",
      good: top.good,
      qty: top.qty,
      dst: top.to,
      netProfit: top.totalProfit,
      ticks: top.travelTicks + 1,
      profitPerTick: top.profitPerTick,
    };
  }

  // Low fuel + nothing to do → suggest topping off opportunistically
  if (fuel && ft) {
    const fraction = fuel.qty / ship.fuelCapacity;
    if (fraction < FUEL_LOW_FRACTION && selectRefuelType(world, ship) != null) {
      return { kind: "refuel", critical: false, reason: `Tank at ${(fraction * 100).toFixed(0)}% — top off while waiting for opportunities.` };
    }
  }

  return { kind: "wait", reason: "No profitable trades from here right now. Wait for prices to shift, or move on speculation." };
}

function cargoLoadedHint(world: World, ship: Trader): GuidedHint {
  const cargo = ship.cargo!;
  const good = world.goods[cargo.good];
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;

  const hereMarket = world.markets[ship.location];
  const hereGross = hereMarket.prices[cargo.good];
  const hereNet = hereGross * (1 - SALES_TAX_RATE);
  const hereRevenue = cargo.qty * hereNet;

  let bestTravel: { dst: LocationId; net: number; ticks: number } | null = null;

  if (ft && fuel) {
    for (const { to, dist } of reachableNeighbors(world, ship.location)) {
      const fuelNeeded = dist * ft.perDistance;
      if (fuelNeeded > fuel.qty) continue;
      const dstMarket = world.markets[to];
      const dstLoc = world.locations[to];
      const dstTarget = dstLoc.targetStock[cargo.good] ?? 0;
      const dstStockNow = dstMarket.stock[cargo.good] ?? 0;
      const dstStockAfter = dstStockNow; // we ignore inflight-from-others here for simplicity
      const dstGross = dstTarget > 0
        ? priceFor(good.basePrice, dstStockAfter, dstTarget)
        : dstMarket.prices[cargo.good];
      const dstNet = dstGross * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * (hereMarket.prices[fuel.good] ?? 0);
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
      const netRevenue = cargo.qty * dstNet - fuelCost - tripMaint - dockingFee;
      if (!bestTravel || netRevenue > bestTravel.net) {
        bestTravel = { dst: to, net: netRevenue, ticks: travelTicks };
      }
    }
  }

  if (bestTravel && bestTravel.net > hereRevenue + ship.capacity * 0.5) {
    return {
      kind: "travel_to_sell",
      dst: bestTravel.dst,
      good: cargo.good,
      qty: cargo.qty,
      expectedNet: bestTravel.net,
      gainOverHere: bestTravel.net - hereRevenue,
      ticks: bestTravel.ticks,
    };
  }

  return { kind: "sell_here", good: cargo.good, qty: cargo.qty, revenue: hereRevenue };
}

export function describeHint(hint: GuidedHint, world: World): string {
  switch (hint.kind) {
    case "buy_for_route": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      return `Buy ${hint.qty} ${hint.good} here → travel to ${dst} → sell. Net Ç${Math.round(hint.netProfit).toLocaleString()} over ${hint.ticks} ticks (Ç${hint.profitPerTick.toFixed(1)}/t).`;
    }
    case "travel_to_sell": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      return `Travel to ${dst} to sell your ${hint.qty.toFixed(0)} ${hint.good} — expected net Ç${Math.round(hint.expectedNet).toLocaleString()} (Ç${Math.round(hint.gainOverHere).toLocaleString()} better than selling here).`;
    }
    case "sell_here":
      return `Sell your ${hint.qty.toFixed(0)} ${hint.good} here for Ç${Math.round(hint.revenue).toLocaleString()} net. No better destination is reachable.`;
    case "refuel":
      return hint.critical ? `⚠ ${hint.reason}` : hint.reason;
    case "wait":
      return hint.reason;
  }
}

// markers used by the UI to highlight elements
export interface HintTarget {
  buyGood?: GoodId;
  sellCargo?: boolean;
  travelTo?: LocationId;
  refuel?: boolean;
  critical?: boolean;
}

export function hintTarget(hint: GuidedHint): HintTarget {
  switch (hint.kind) {
    case "buy_for_route":
      return { buyGood: hint.good };
    case "travel_to_sell":
      return { travelTo: hint.dst };
    case "sell_here":
      return { sellCargo: true };
    case "refuel":
      return { refuel: true, critical: hint.critical };
    case "wait":
      return {};
  }
}

