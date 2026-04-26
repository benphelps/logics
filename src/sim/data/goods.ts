import type { Good } from "../types";

export const GOODS: Record<string, Good> = {
  grain:    { id: "grain",    name: "Grain",         category: "food",         basePrice:   8, weight: 1.0 },
  fish:     { id: "fish",     name: "Fish",          category: "food",         basePrice:  12, weight: 1.0 },
  meat:     { id: "meat",     name: "Meat",          category: "food",         basePrice:  20, weight: 1.0 },
  ore:      { id: "ore",      name: "Iron Ore",      category: "raw",          basePrice:  10, weight: 2.0 },
  wood:     { id: "wood",     name: "Timber",        category: "raw",          basePrice:   6, weight: 1.5 },
  cloth:    { id: "cloth",    name: "Cloth",         category: "intermediate", basePrice:  18, weight: 0.5 },
  tools:    { id: "tools",    name: "Tools",         category: "intermediate", basePrice:  35, weight: 1.0 },
  spice:    { id: "spice",    name: "Spice",         category: "luxury",       basePrice:  60, weight: 0.3 },
  silk:     { id: "silk",     name: "Silk",          category: "luxury",       basePrice:  90, weight: 0.3 },
  fuel:     { id: "fuel",     name: "Fuel",          category: "fuel",         basePrice:  15, weight: 1.0 },
};
