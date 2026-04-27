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

export interface Trader {
  id: TraderId;
  name: string;
  capacity: number;
  speed: number;
  fuelCapacity: number;
  fuelTypes: FuelType[];
  currentFuel: { good: GoodId; qty: number } | null;
  funds: number;
  location: LocationId;
  state: TraderState;
  cargo: CargoLot | null;
  destination: LocationId | null;
  ticksRemaining: number;
  pilot: PilotMode;
}

export interface Player {
  funds: number;
  shipIds: TraderId[];
}

export interface World {
  tick: number;
  goods: Record<GoodId, Good>;
  locations: Record<LocationId, LocationDef>;
  markets: Record<LocationId, MarketState>;
  lanes: LaneMap;
  traders: Record<TraderId, Trader>;
  player: Player | null;
}
