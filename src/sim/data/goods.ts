import type { Good } from "../types";

export const GOODS: Record<string, Good> = {
  grain:     { id: "grain",     name: "Hydroponic Grain", category: "food",         basePrice:   8, weight: 1.0 },
  protein:   { id: "protein",   name: "Cultured Protein", category: "food",         basePrice:  12, weight: 1.0 },
  vatmeat:   { id: "vatmeat",   name: "Vat Meat",         category: "food",         basePrice:  20, weight: 1.0 },
  ore:       { id: "ore",       name: "Asteroid Ore",     category: "raw",          basePrice:  10, weight: 2.0 },
  polymer:   { id: "polymer",   name: "Polymer",          category: "raw",          basePrice:   6, weight: 1.5 },
  fiber:     { id: "fiber",     name: "Microfiber",       category: "intermediate", basePrice:  18, weight: 0.5 },
  parts:     { id: "parts",     name: "Machine Parts",    category: "intermediate", basePrice:  35, weight: 1.0 },
  xenospice: { id: "xenospice", name: "Xenospice",        category: "luxury",       basePrice:  60, weight: 0.3 },
  silk:      { id: "silk",      name: "Quantum Silk",     category: "luxury",       basePrice:  90, weight: 0.3 },
  plasma:    { id: "plasma",    name: "Plasma Fuel",      category: "fuel",         basePrice:  15, weight: 1.0 },
};
