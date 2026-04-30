import type { LocationDef, MarketState, Trader, World } from "./types";
import {
  combinedShipModifiers,
  dockingDiscountFraction,
  fuelRegenPerTick,
  hasCrew,
  totalCrewWage,
  treasuryYieldRate,
} from "./crew";

export const MAINTENANCE_PER_CAPACITY = 0.5;
export const MAINTENANCE_IDLE_FACTOR = 0;
export const CREW_WAGES_PER_CAPACITY = 0;
export const DOCKING_FEE_PER_CAPACITY = 5;
export const SALES_TAX_RATE = 0.15;
export const STOCKPILE_CAP_MULT = 3.0;
export const CONSUMPTION_RATION_FLOOR = 0.2;
export const CONSUMPTION_RATION_BAND = 0.35;
export const CONSUMPTION_RESERVE_FRACTION = 0.04;

// --- treasury / closed-money-loop ----------------------------------------
// Treasuries make every dollar in the system come from somewhere and go
// somewhere. Trader sells draw from a city's treasury; trader buys deposit
// into it. Tax + docking fees stay in the treasury (transferred, not
// destroyed). Real sinks: maintenance + crew wages (genuine wear-and-tear /
// off-station expense). Real source: per-tick replenishment, sized to roughly
// balance the sinks at steady state.

export const TREASURY_PER_POPULATION = 150;             // initial size + replenish target
// Per-tick replenishment per population. Tuned so total replenishment ≈ total
// maintenance drain at steady state across 4 / 12 / 50-location universes.
// At 50-loc with 75 traders (avg 30 in transit × 75 cap × 0.5 maint/cap =
// ~1125/tick drain) and 35k pop, this gives 1225/tick replenish — slight
// surplus that closes the loop after maintenance + minor sinks.
export const TREASURY_REPLENISH_PER_POP_PER_TICK = 0.035;
// When treasury dips below 0 (in deficit), the city can't pay full price for
// new arrivals. Haircut tapers linearly to a floor — depleted cities still
// pay something so traders can survive a depressed destination. Without the
// floor, the trader → stuck → can't refuel → broke spiral runs away at scale.
export const TREASURY_HAIRCUT_START_FRACTION = 0.0;
export const TREASURY_HAIRCUT_FULL_FRACTION = -1.0;
export const TREASURY_HAIRCUT_FLOOR = 0.50;
export const TREASURY_FLOOR_FRACTION = -2.0;            // hard cap on city debt (no further withdrawals beyond this)

export function defaultTreasuryTarget(loc: LocationDef): number {
  return Math.max(50_000, loc.population * TREASURY_PER_POPULATION);
}

export function treasuryHealthMultiplier(market: MarketState): number {
  const target = market.treasuryTarget || 1;
  const ratio = market.treasury / target;
  if (ratio >= TREASURY_HAIRCUT_START_FRACTION) return 1.0;
  if (ratio <= TREASURY_HAIRCUT_FULL_FRACTION) return TREASURY_HAIRCUT_FLOOR;
  // Linear from FLOOR (at FULL_FRACTION) to 1.0 (at START_FRACTION)
  const span = TREASURY_HAIRCUT_START_FRACTION - TREASURY_HAIRCUT_FULL_FRACTION;
  const t = (ratio - TREASURY_HAIRCUT_FULL_FRACTION) / span;
  return TREASURY_HAIRCUT_FLOOR + (1 - TREASURY_HAIRCUT_FLOOR) * t;
}

export function depositToTreasury(market: MarketState, amount: number): void {
  if (amount <= 0) return;
  market.treasury += amount;
}

// Withdraw from treasury; returns the amount actually paid. Treasury can go
// negative (city in debt) but only as far as TREASURY_FLOOR_FRACTION × target.
// If the cap is hit, the trader gets the partial payment.
export function withdrawFromTreasury(market: MarketState, amount: number): number {
  if (amount <= 0) return 0;
  const target = market.treasuryTarget || 1;
  const floor = target * TREASURY_FLOOR_FRACTION;
  const available = market.treasury - floor;
  const paid = Math.max(0, Math.min(amount, available));
  market.treasury -= paid;
  return paid;
}

// One trader sells `qty` of a good to a city. Returns what flows where:
//  - traderRevenue: cash the trader receives (post-tax, post-haircut)
//  - taxKept:        the tax the city retains in its treasury (was previously destroyed)
//  - effectiveUnitPrice: the per-unit value the trader actually realized
// The treasury accounting: treasury -= traderRevenue. The tax fraction never
// leaves the treasury, so the effective net flow out of the city = traderRevenue.
export interface SaleSettlement {
  effectiveUnitPrice: number;
  traderRevenue: number;
  taxKept: number;
  haircut: number;
}

export function settleSale(market: MarketState, grossUnitPrice: number, qty: number): SaleSettlement {
  if (qty <= 0 || grossUnitPrice <= 0) {
    return { effectiveUnitPrice: 0, traderRevenue: 0, taxKept: 0, haircut: 1 };
  }
  const haircut = treasuryHealthMultiplier(market);
  const offerUnitPrice = grossUnitPrice * haircut;
  const traderUnitPrice = offerUnitPrice * (1 - SALES_TAX_RATE);
  // Compute the gross payout the city would owe the trader (after tax retained).
  // Then cap by what the treasury can actually afford given the floor.
  const traderRevenueWanted = traderUnitPrice * qty;
  const paid = withdrawFromTreasury(market, traderRevenueWanted);
  const realizedUnitPrice = qty > 0 ? paid / qty : 0;
  const taxKept = haircut > 0 ? (paid / Math.max(0.001, 1 - SALES_TAX_RATE)) * SALES_TAX_RATE : 0;
  // C-5: cargo arriving for sale is an INFLOW (the station is importing
  // goods) — debits net-trade flow because exports < imports lowers
  // station productivity. The flow signal is sign-aware so net-exporter
  // stations carry positive netTradeFlow.
  market.netTradeFlow = (market.netTradeFlow ?? 0) - paid;
  return {
    effectiveUnitPrice: realizedUnitPrice,
    traderRevenue: paid,
    taxKept,
    haircut,
  };
}

export interface PurchaseSettlement {
  totalCost: number;
}

// Trader purchase from market: cash flows from trader → city treasury. No tax
// on purchases; we model that as an export tariff on sells, not a sales tax
// on buys.
export function settlePurchase(market: MarketState, grossUnitPrice: number, qty: number): PurchaseSettlement {
  if (qty <= 0 || grossUnitPrice <= 0) return { totalCost: 0 };
  const totalCost = grossUnitPrice * qty;
  depositToTreasury(market, totalCost);
  // C-5: cargo leaving is an OUTFLOW (the station is exporting goods)
  // — credits net-trade flow. Net-exporter stations earn positive
  // netTradeFlow over time, which lifts their equity fundamental.
  market.netTradeFlow = (market.netTradeFlow ?? 0) + totalCost;
  return { totalCost };
}

// C-5: decay rate for the per-station netTradeFlow signal. With 0.99
// per tick, a one-time +1000 flow halves in ~70 ticks and decays to
// near-zero in ~500 ticks. Slow enough that consistent producers
// build a steady-state premium; fast enough that a one-shot surge
// doesn't pin the station's equity for the rest of the game.
export const NET_TRADE_DECAY = 0.99;

export function tickTreasuries(world: World): void {
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    if (!market) continue;
    if (market.treasuryTarget == null) market.treasuryTarget = defaultTreasuryTarget(loc);
    if (market.treasury == null) market.treasury = market.treasuryTarget;
    // Replenishment tapers based on how full the treasury is. Below target,
    // full rate. At target, half rate. Far above target, drops to ~10% of
    // base. This keeps total system money bounded — once treasuries are well
    // above target, replenish drops below maintenance drain and the system
    // self-balances.
    const replenishMax = loc.population * TREASURY_REPLENISH_PER_POP_PER_TICK;
    const ratio = market.treasury / Math.max(1, market.treasuryTarget);
    let multiplier: number;
    if (ratio <= 0) multiplier = 1.5;                      // deficit cities replenish faster
    else if (ratio <= 1.0) multiplier = 1.5 - 0.5 * ratio; // at target = 1.0, below = 1.0-1.5
    else multiplier = Math.max(0.05, 1.0 / (1 + (ratio - 1.0) * 3));
    market.treasury += replenishMax * multiplier;
    // C-5: decay net-trade flow each tick so the signal tracks
    // recent activity rather than lifetime totals.
    if (market.netTradeFlow) market.netTradeFlow *= NET_TRADE_DECAY;
  }
}

export function productionScale(stock: number, target: number): number {
  if (target <= 0) return 1.0;
  if (stock >= target * STOCKPILE_CAP_MULT) return 0;
  if (stock <= target) return 1.0;
  return 1 - (stock - target) / (target * (STOCKPILE_CAP_MULT - 1));
}

export function consumptionDemand(have: number, want: number, target: number): number {
  if (have <= 0 || want <= 0) return 0;
  if (target <= 0) return Math.min(have, want);

  const reserve = target * CONSUMPTION_RESERVE_FRACTION;
  const available = Math.max(0, have - reserve);
  if (available <= 0) return 0;

  const ratio = have / target;
  if (ratio >= CONSUMPTION_RATION_BAND) return Math.min(available, want);

  const pressure = Math.max(0, ratio / CONSUMPTION_RATION_BAND);
  const scale = CONSUMPTION_RATION_FLOOR + (1 - CONSUMPTION_RATION_FLOOR) * pressure;
  return Math.min(available, want * scale);
}

// Wealth-proportional carry cost on NPC traders — flows to the local treasury
// (closed loop, not destroyed). Without this, traders extract money from city
// treasuries faster than the trade flow returns it, and aggregate trader
// wealth drifts upward indefinitely. With it, NPC fleet wealth equilibrium
// settles at roughly the level where `wealth × rate ≈ trade-extraction rate`.
// Player ships exempt — their growth pace is set by contracts and crew costs.
export const NPC_WEALTH_CARRY_PER_TICK = 0.0008;

function isPlayerShip(world: World, ship: Trader): boolean {
  return world.player?.shipIds.includes(ship.id) ?? false;
}

export function chargeNpcWealthCarry(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (isPlayerShip(world, trader)) continue;
    if (trader.funds <= 0) continue;
    const owed = trader.funds * NPC_WEALTH_CARRY_PER_TICK;
    if (owed <= 0) continue;
    const paid = Math.min(owed, trader.funds);
    trader.funds = Math.max(0, trader.funds - paid);
    // Closed loop: redirects to current location's treasury (or destination
    // for in-transit ships). The cities benefit from NPC trade activity
    // through this mechanism — the wealthier the fleet, the more revenue
    // flows back to the cities they pass through.
    const locId = trader.state === "transit" ? (trader.destination ?? trader.location) : trader.location;
    const market = world.markets[locId];
    if (market) depositToTreasury(market, paid);
  }
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

export function chargeDockingFee(world: World, trader: Trader): number {
  if (trader.funds <= 0) return 0;
  const baseFee = trader.capacity * DOCKING_FEE_PER_CAPACITY;
  const fee = baseFee * (1 - dockingDiscountFraction(trader));
  const paid = Math.min(fee, trader.funds);
  trader.funds = Math.max(0, trader.funds - fee);
  // Docking fee transfers to local treasury — the city earns from each
  // docking, which they then pay back out via sells. Closes the loop.
  const market = world.markets[trader.location];
  if (market) depositToTreasury(market, paid);
  return paid;
}

// Per-tick passive perks for idle/docked ships: fuel regen tops up the
// tank, treasury yield credits a small interest on the ship's idle
// funds. Both are no-ops unless the corresponding upgrade modifier is
// installed. Called from the same per-tick pass as chargeOperationalCosts.
export function applyIdlePerks(world: World): void {
  for (const trader of Object.values(world.traders)) {
    if (trader.state !== "idle") continue;

    const regen = fuelRegenPerTick(trader);
    if (regen > 0 && trader.currentFuel) {
      const next = Math.min(trader.fuelCapacity, trader.currentFuel.qty + regen);
      trader.currentFuel = { good: trader.currentFuel.good, qty: next };
    }

    const yieldRate = treasuryYieldRate(trader);
    if (yieldRate > 0 && trader.funds > 0) {
      // Yield is funded by the dock's market treasury (a "money-market
      // sweep" feel) so the float stays conserved.
      const market = world.markets[trader.location];
      if (market) {
        const want = trader.funds * yieldRate;
        const paid = withdrawFromTreasury(market, want);
        if (paid > 0) trader.funds += paid;
      }
    }
  }
  void world;
}

export const chargeMaintenance = chargeOperationalCosts;
