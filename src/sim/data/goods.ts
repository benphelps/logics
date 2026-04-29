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
  antimatter:{ id: "antimatter",name: "Antimatter Cell",  category: "fuel",         basePrice:  30, weight: 0.5 },

  electronics:  { id: "electronics",  name: "Electronics",  category: "advanced", basePrice:  80, weight: 0.4 },
  weapons:      { id: "weapons",      name: "Weapons",      category: "advanced", basePrice:  70, weight: 1.2 },
  luxury_goods: { id: "luxury_goods", name: "Luxury Goods", category: "advanced", basePrice: 120, weight: 0.4 },
  medkits:      { id: "medkits",      name: "Medkits",      category: "advanced", basePrice:  50, weight: 0.3 },

  // --- cargo upgrades -----------------------------------------------------
  upg_cargo_1:        { id: "upg_cargo_1",        name: "Standard Cargo Bay",       category: "upgrade", basePrice:   8_000, weight: 3.0 },
  upg_cargo_modular_1: { id: "upg_cargo_modular_1", name: "Modular Container Bay",   category: "upgrade", basePrice:  11_500, weight: 3.0 },
  upg_cargo_2:        { id: "upg_cargo_2",        name: "Heavy Hauler Frame",       category: "upgrade", basePrice:  24_000, weight: 3.0 },
  upg_cargo_loader_2: { id: "upg_cargo_loader_2", name: "Rapid Cargo Lift",         category: "upgrade", basePrice:  42_000, weight: 3.0 },
  upg_cargo_smuggler_2: { id: "upg_cargo_smuggler_2", name: "Smuggler's Compartment", category: "upgrade", basePrice:  38_000, weight: 3.0 },
  upg_cargo_3:        { id: "upg_cargo_3",        name: "Megahauler Conversion",    category: "upgrade", basePrice:  64_000, weight: 3.0 },
  upg_cargo_loader_3: { id: "upg_cargo_loader_3", name: "Zero-G Unload Matrix",     category: "upgrade", basePrice: 110_000, weight: 3.0 },
  upg_cargo_atlas_3:  { id: "upg_cargo_atlas_3",  name: "Atlas Hauler Spine",       category: "upgrade", basePrice:  88_000, weight: 3.0 },

  // --- engine upgrades ----------------------------------------------------
  upg_engine_1:       { id: "upg_engine_1",       name: "Vector Thrusters",         category: "upgrade", basePrice:  10_000, weight: 2.0 },
  upg_engine_solar_1: { id: "upg_engine_solar_1", name: "Solar Sail Rig",           category: "upgrade", basePrice:  13_500, weight: 2.0 },
  upg_engine_2:       { id: "upg_engine_2",       name: "Slipstream Drive",         category: "upgrade", basePrice:  30_000, weight: 2.0 },
  upg_engine_micro_2: { id: "upg_engine_micro_2", name: "Microjump Coil",           category: "upgrade", basePrice:  34_000, weight: 2.0 },
  upg_engine_3:       { id: "upg_engine_3",       name: "FTL Fold Drive",           category: "upgrade", basePrice:  95_000, weight: 2.0 },
  upg_engine_singularity_3: { id: "upg_engine_singularity_3", name: "Singularity Burst Drive", category: "upgrade", basePrice: 105_000, weight: 2.0 },

  // --- fuel upgrades ------------------------------------------------------
  upg_fuel_1:         { id: "upg_fuel_1",         name: "Fuel Reclaimer Pump",      category: "upgrade", basePrice:   7_500, weight: 2.5 },
  upg_fuel_solar_1:   { id: "upg_fuel_solar_1",   name: "Solar Bloom Collector",    category: "upgrade", basePrice:   9_500, weight: 2.5 },
  upg_fuel_2:         { id: "upg_fuel_2",         name: "Hydrogen Spinner Reclaimer", category: "upgrade", basePrice: 22_000, weight: 2.5 },
  upg_fuel_aux_2:     { id: "upg_fuel_aux_2",     name: "Auxiliary Tank Lattice",   category: "upgrade", basePrice:  26_500, weight: 2.5 },
  upg_fuel_3:         { id: "upg_fuel_3",         name: "Zero-Point Fuel Core",     category: "upgrade", basePrice:  90_000, weight: 2.5 },
  upg_fuel_bio_3:     { id: "upg_fuel_bio_3",     name: "Bio-Reactor Stack",        category: "upgrade", basePrice:  82_000, weight: 2.5 },

  // --- hull upgrades ------------------------------------------------------
  upg_hull_1:         { id: "upg_hull_1",         name: "Reinforced Plating",       category: "upgrade", basePrice:   9_000, weight: 4.0 },
  upg_hull_2:         { id: "upg_hull_2",         name: "Composite Battle Plating", category: "upgrade", basePrice:  26_000, weight: 4.0 },
  upg_hull_ablative_2: { id: "upg_hull_ablative_2", name: "Ablative Plate Layers",  category: "upgrade", basePrice:  31_000, weight: 4.0 },
  upg_hull_stealth_2: { id: "upg_hull_stealth_2", name: "Photon Damping Coat",      category: "upgrade", basePrice:  29_500, weight: 4.0 },
  upg_hull_3:         { id: "upg_hull_3",         name: "Adamant Carapace",         category: "upgrade", basePrice:  70_000, weight: 4.0 },
  upg_hull_nano_3:    { id: "upg_hull_nano_3",    name: "Self-Repair Nanite Mesh",  category: "upgrade", basePrice:  72_000, weight: 4.0 },

  // --- weapon upgrades ----------------------------------------------------
  upg_weapon_1:        { id: "upg_weapon_1",        name: "Pulse Cannon Turret",    category: "upgrade", basePrice:  12_000, weight: 3.5 },
  upg_weapon_defense_1: { id: "upg_weapon_defense_1", name: "Point-Defense Lattice", category: "upgrade", basePrice: 14_000, weight: 3.5 },
  upg_weapon_2:        { id: "upg_weapon_2",        name: "Quad Gauss Battery",     category: "upgrade", basePrice:  36_000, weight: 3.5 },
  upg_weapon_bounty_2: { id: "upg_weapon_bounty_2", name: "Bounty Hunter Rig",      category: "upgrade", basePrice:  41_000, weight: 3.5 },
  upg_weapon_3:        { id: "upg_weapon_3",        name: "Plasma Lance Array",     category: "upgrade", basePrice:  90_000, weight: 3.5 },
  upg_weapon_emp_3:    { id: "upg_weapon_emp_3",    name: "EMP Disruptor Array",    category: "upgrade", basePrice:  86_000, weight: 3.5 },

  // --- systems upgrades ---------------------------------------------------
  upg_systems_nav_1:        { id: "upg_systems_nav_1",        name: "Survey Computer",       category: "upgrade", basePrice:  12_000, weight: 1.0 },
  upg_systems_haggler_1:    { id: "upg_systems_haggler_1",    name: "Haggler's Earpiece",    category: "upgrade", basePrice:  15_500, weight: 1.0 },
  upg_systems_exchange_2:   { id: "upg_systems_exchange_2",   name: "Exchange Relay",        category: "upgrade", basePrice:  55_000, weight: 1.0 },
  upg_systems_ticker_2:     { id: "upg_systems_ticker_2",     name: "Bridge Ticker Tape",    category: "upgrade", basePrice:  47_000, weight: 1.0 },
  upg_systems_oracle_3:     { id: "upg_systems_oracle_3",     name: "Oracle Trade Core",     category: "upgrade", basePrice: 130_000, weight: 1.0 },
  upg_systems_pressure_3:   { id: "upg_systems_pressure_3",   name: "Pressure Atlas Console", category: "upgrade", basePrice: 118_000, weight: 1.0 },

  // --- phase B variants (new effects) -------------------------------------
  upg_fuel_regen_2:         { id: "upg_fuel_regen_2",         name: "Hyperion Bloom Reclaimer", category: "upgrade", basePrice:  28_500, weight: 2.5 },
  upg_systems_treasury_2:   { id: "upg_systems_treasury_2",   name: "Bonded Treasury Module",   category: "upgrade", basePrice:  62_000, weight: 1.0 },
  upg_systems_dock_2:       { id: "upg_systems_dock_2",       name: "Diplomatic Beacon",        category: "upgrade", basePrice:  45_000, weight: 1.0 },
  upg_systems_dividend_3:   { id: "upg_systems_dividend_3",   name: "Shareholder Relations Suite", category: "upgrade", basePrice: 124_000, weight: 1.0 },
  upg_systems_haggler_2:    { id: "upg_systems_haggler_2",    name: "Negotiator's Console",     category: "upgrade", basePrice:  58_000, weight: 1.0 },
};
