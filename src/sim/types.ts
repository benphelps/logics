export type GoodId = string;
export type LocationId = string;
export type TraderId = string;

export type GoodCategory = "food" | "raw" | "intermediate" | "luxury" | "fuel";

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

export interface FuelType {
  good: GoodId;
  perDistance: number;
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
  cargo: { good: GoodId; qty: number } | null;
  destination: LocationId | null;
  ticksRemaining: number;
}

export interface World {
  tick: number;
  goods: Record<GoodId, Good>;
  locations: Record<LocationId, LocationDef>;
  markets: Record<LocationId, MarketState>;
  lanes: LaneMap;
  traders: Record<TraderId, Trader>;
}
