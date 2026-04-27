export type GoodId = string;
export type LocationId = string;
export type TraderId = string;

export type GoodCategory = "food" | "raw" | "intermediate" | "luxury" | "fuel" | "advanced";

export interface Good {
  id: GoodId;
  name: string;
  category: GoodCategory;
  basePrice: number;
  weight: number;
}

export interface ProductionEntry {
  good: GoodId;
  ratePerTick: number;
  inputs?: { good: GoodId; perUnit: number }[];
  requiresTechLevel?: number;
}

export interface ConsumptionEntry {
  good: GoodId;
  ratePerTick: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface LocationTraits {
  techLevel: number;
  tags: string[];
  faction?: string;
}

export interface LocationDef {
  id: LocationId;
  name: string;
  position: Position;
  population: number;
  traits: LocationTraits;
  primaryExports: GoodId[];
  primaryImports: GoodId[];
  produces: ProductionEntry[];
  consumes: ConsumptionEntry[];
  targetStock: Partial<Record<GoodId, number>>;
}

export type LaneMap = Record<LocationId, Record<LocationId, number>>;

export interface MarketState {
  stock: Record<GoodId, number>;
  prices: Record<GoodId, number>;
}

export type TraderState = "idle" | "transit";
export type PilotMode = "npc" | "manual" | "auto";

export interface FuelType {
  good: GoodId;
  perDistance: number;
}

export interface CargoLot {
  good: GoodId;
  qty: number;
  source: LocationId;       // where it was loaded (most recent for incremental adds)
  unitPrice: number;        // weighted-average cost basis per unit
  purchasedAt: number;      // tick of first purchase (oldest, for age calculations)
}

export type CrewRole = "captain" | "navigator" | "mechanic";    // mercenary reserved for combat-era

// Modifiers a crew member contributes to the ship. Each field is additive
// across all hired crew. Stat-touching fields (cargo/speed/fuel/range) are
// recomputed onto the ship via recomputeShipStats(); action-time fields
// (buy/sell/contract %) are read at the moment of action — they're scaffolded
// here so future hires can carry them without a type change.
export interface CrewModifiers {
  cargoCapacityBonus?: number;        // +N flat cargo capacity
  fuelCapacityBonus?: number;         // +N flat fuel tank
  speedBonus?: number;                // +N flat ship speed
  rangeEfficiency?: number;           // 0.10 = 10% reduction in fuel-per-distance
  buyDiscount?: number;               // 0.05 = 5% off buy price (NOT YET WIRED)
  sellPremium?: number;               // 0.05 = 5% bonus on sell (NOT YET WIRED)
  maintenanceDiscount?: number;       // 0.10 = 10% off maintenance/tick
  contractRewardBonus?: number;       // 0.10 = +10% contract reward (NOT YET WIRED)
}

export interface CrewMember {
  id: string;
  role: CrewRole;
  name: string;
  tier: number;                       // 1-5, drives base price scaling
  hireCost: number;                   // one-time cost to sign on
  wagePerTick: number;                // ongoing cost charged each tick
  modifiers: CrewModifiers;
}

export type ShipCrew = Partial<Record<CrewRole, CrewMember>>;

export type HireId = string;

// A crew offer posted at a station. Same structural shape as CrewMember plus
// location + expiry — once hired, a CrewMember snapshot is copied onto the
// ship (so firing later doesn't accidentally re-list the offer).
export interface Hire {
  id: HireId;
  role: CrewRole;
  name: string;
  tier: number;
  hireCost: number;
  wagePerTick: number;
  modifiers: CrewModifiers;
  location: LocationId;
  postedTick: number;
  expiresAt: number;
}

export interface Trader {
  id: TraderId;
  name: string;

  // Effective stats (used by the sim — recomputed when crew changes).
  capacity: number;
  speed: number;
  fuelCapacity: number;

  // Base stats (the ship's intrinsic numbers — never change from crew).
  // Optional for back-compat with traders constructed inline by older tests;
  // recomputeShipStats falls back to current effective values if base is unset.
  baseCapacity?: number;
  baseSpeed?: number;
  baseFuelCapacity?: number;

  fuelTypes: FuelType[];
  currentFuel: { good: GoodId; qty: number } | null;
  funds: number;
  location: LocationId;
  state: TraderState;
  cargo: CargoLot[];                // empty array = no cargo. Each lot is one good; per-good lots merge with weighted avg.
  destination: LocationId | null;
  ticksRemaining: number;
  pilot: PilotMode;
  stuckTicks?: number;              // ticks the trader has been stuck (out of fuel + isolated). Drives rescue-job tier.
  log: ShipLogEntry[];              // capped action history (oldest entries dropped). Drives the per-ship log card.
  crew?: ShipCrew;                  // player-only — NPCs operate without a crew model.
  maintenanceDebt?: number;         // accrued unpaid maintenance for player ships missing a mechanic.
}

export type ShipLogTone = "good" | "bad" | "warn" | "info";

export interface ShipLogEntry {
  tick: number;
  kind: string;                     // "buy" | "sell" | "depart" | "arrive" | "refuel" | "stuck" | "job_accepted" | "job_completed" | "job_expired" | "job_abandoned"
  message: string;                  // pre-formatted, plain text
  tone?: ShipLogTone;
}

// TraderEvent lives here (not in traders.ts) so log.ts and other consumers
// can reference it without dragging in the trader runtime.
export interface TraderEvent {
  trader: string;
  kind: "buy" | "sell" | "depart" | "arrive" | "idle" | "refuel" | "stuck";
  good?: GoodId;
  qty?: number;
  unitPrice?: number;
  from?: LocationId;
  to?: LocationId;
}

export interface Player {
  funds: number;
  shipIds: TraderId[];
}

export type JobKind = "shortage" | "rescue";
export type JobTier = "low" | "medium" | "high";
export type JobId = string;

export interface Job {
  id: JobId;
  kind: JobKind;
  tier: JobTier;
  good: GoodId;
  qty: number;
  destination: LocationId;
  reward: number;
  penalty: number;          // currency penalty if accepted-then-failed (0 for low tier)
  postedTick: number;
  expiresAt: number;
  acceptedBy: TraderId | null;
  delivered: number;        // running tally of delivered qty (for partial deliveries)
  rescueTarget?: TraderId;  // for rescue jobs only — informational
}

export interface World {
  tick: number;
  goods: Record<GoodId, Good>;
  locations: Record<LocationId, LocationDef>;
  markets: Record<LocationId, MarketState>;
  lanes: LaneMap;
  traders: Record<TraderId, Trader>;
  player: Player | null;
  jobs: Record<JobId, Job>;
  nextJobId: number;
  hires: Record<HireId, Hire>;
  nextHireId: number;
}
