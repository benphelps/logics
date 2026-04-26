export type GoodId = string;
export type LocationId = string;

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

export interface LocationDef {
  id: LocationId;
  name: string;
  population: number;
  produces: ProductionEntry[];
  consumes: ConsumptionEntry[];
  targetStock: Partial<Record<GoodId, number>>;
}

export interface MarketState {
  stock: Record<GoodId, number>;
  prices: Record<GoodId, number>;
}

export interface World {
  tick: number;
  goods: Record<GoodId, Good>;
  locations: Record<LocationId, LocationDef>;
  markets: Record<LocationId, MarketState>;
  distances: Record<LocationId, Record<LocationId, number>>;
}
