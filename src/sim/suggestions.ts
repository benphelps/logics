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

  // Consider both buy-here-and-travel options AND (if cargo is loaded) sell
  // and travel-to-sell options. Pick the single highest-value action across
  // all of them. This makes the engine "hedging-aware" — when the player has
  // partial cargo, the engine can suggest topping off with a different good
  // if that's the best move, instead of being stuck on the existing cargo.

  // Player isn't subject to MAX_DRAW_FRACTION (NPC fairness rule).
  const drawFraction = ship.pilot === "manual" ? 1.0 : undefined;
  const buyOptions = listTradeOptions(world, ship, undefined, drawFraction);
  const cargoSell = ship.cargo.length > 0 ? cargoLoadedCandidates(world, ship) : [];

  type Candidate = { value: number; hint: GuidedHint };
  const candidates: Candidate[] = [];

  for (const o of buyOptions) {
    candidates.push({
      value: o.totalProfit,
      hint: {
        kind: "buy_for_route",
        good: o.good,
        qty: o.qty,
        dst: o.to,
        netProfit: o.totalProfit,
        ticks: o.travelTicks + 1,
        profitPerTick: o.profitPerTick,
      },
    });
  }
  candidates.push(...cargoSell);

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.value - a.value);
    return candidates[0].hint;
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

// Returns scored candidates for actions involving the loaded cargo (sell here
// or travel-to-sell). One entry per (good × destination), aggregated across
// per-good lots since selling N units of good X uses FIFO across all lots.
// The "value" is realized P&L (revenue - cost basis) so it compares apples-
// to-apples with buy_for_route's totalProfit.
function cargoLoadedCandidates(world: World, ship: Trader): { value: number; hint: GuidedHint }[] {
  const ft = activeFuelType(ship);
  const fuel = ship.currentFuel;
  const hereMarket = world.markets[ship.location];
  const out: { value: number; hint: GuidedHint }[] = [];

  // Aggregate per-good across lots
  const byGood = new Map<string, { totalQty: number; totalCost: number }>();
  for (const lot of ship.cargo) {
    const g = byGood.get(lot.good) ?? { totalQty: 0, totalCost: 0 };
    g.totalQty += lot.qty;
    g.totalCost += lot.qty * lot.unitPrice;
    byGood.set(lot.good, g);
  }

  for (const [goodId, agg] of byGood) {
    const good = world.goods[goodId];
    if (!good) continue;
    const hereGross = hereMarket.prices[goodId];
    const hereNet = hereGross * (1 - SALES_TAX_RATE);
    const hereRevenue = agg.totalQty * hereNet;
    const sellHerePnL = hereRevenue - agg.totalCost;

    out.push({
      value: sellHerePnL,
      hint: { kind: "sell_here", good: goodId, qty: agg.totalQty, revenue: hereRevenue },
    });

    if (!ft || !fuel) continue;

    for (const { to, dist } of reachableNeighbors(world, ship.location)) {
      const fuelNeeded = dist * ft.perDistance;
      if (fuelNeeded > fuel.qty) continue;
      const dstMarket = world.markets[to];
      const dstLoc = world.locations[to];
      const dstTarget = dstLoc.targetStock[goodId] ?? 0;
      const dstStockNow = dstMarket.stock[goodId] ?? 0;
      const dstGross = dstTarget > 0
        ? priceFor(good.basePrice, dstStockNow, dstTarget)
        : dstMarket.prices[goodId];
      const dstNet = dstGross * (1 - SALES_TAX_RATE);
      const fuelCost = fuelNeeded * (hereMarket.prices[fuel.good] ?? 0);
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const tripMaint = travelTicks * ship.capacity * MAINTENANCE_PER_CAPACITY;
      const dockingFee = ship.capacity * DOCKING_FEE_PER_CAPACITY;
      const netRevenue = agg.totalQty * dstNet - fuelCost - tripMaint - dockingFee;
      const travelPnL = netRevenue - agg.totalCost;
      out.push({
        value: travelPnL,
        hint: {
          kind: "travel_to_sell",
          dst: to,
          good: goodId,
          qty: agg.totalQty,
          expectedNet: netRevenue,
          gainOverHere: netRevenue - hereRevenue,
          ticks: travelTicks,
        },
      });
    }
  }

  return out;
}

export function describeHint(hint: GuidedHint, world: World): string {
  const goodName = (id: string) => world.goods[id]?.name ?? id;
  switch (hint.kind) {
    case "buy_for_route": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      return `Buy ${hint.qty} ${goodName(hint.good)} here → travel to ${dst} → sell. Net Ç${Math.round(hint.netProfit).toLocaleString()} over ${hint.ticks} ticks (Ç${hint.profitPerTick.toFixed(1)}/t).`;
    }
    case "travel_to_sell": {
      const dst = world.locations[hint.dst]?.name ?? hint.dst;
      return `Travel to ${dst} to sell your ${hint.qty.toFixed(0)} ${goodName(hint.good)} — expected net Ç${Math.round(hint.expectedNet).toLocaleString()} (Ç${Math.round(hint.gainOverHere).toLocaleString()} better than selling here).`;
    }
    case "sell_here":
      return `Sell your ${hint.qty.toFixed(0)} ${goodName(hint.good)} here for Ç${Math.round(hint.revenue).toLocaleString()} net. No better destination is reachable.`;
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

