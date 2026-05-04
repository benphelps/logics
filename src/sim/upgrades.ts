import type { CrewModifiers, GoodId, ShipClass, ShipUpgradeSlots, Trader, UpgradeSlot, UpgradeTier } from "./types";

export interface ShipUpgradeDef {
  id: GoodId;
  slot: UpgradeSlot;
  tier: UpgradeTier;
  name: string;
  // Optional flavor blurb for the upgrade panel — short enough to fit
  // under the name without breaking the row layout. Not all upgrades
  // need one; the UI should fall back to upgradeEffectText().
  description?: string;
  effects: CrewModifiers;
}

export const UPGRADE_SLOTS: { slot: UpgradeSlot; label: string }[] = [
  { slot: "cargo", label: "Cargo Hold" },
  { slot: "engine", label: "Engines" },
  { slot: "fuel", label: "Fuel Tanks" },
  { slot: "hull", label: "Hull" },
  { slot: "weapon", label: "Weapons" },
  { slot: "weapon_2", label: "Weapons II" },
  { slot: "weapon_3", label: "Weapons III" },
  { slot: "systems", label: "Ship Systems" },
];

// Weapon mount counts per ship class. Cruisers carry 2, exotics 3, every
// other class is a single-mount trader. Drives both the upgrade UI (which
// slots to render) and the install router (which mount to drop a weapon
// into when the player clicks Install).
export function weaponMountsForClass(cls: ShipClass | undefined): number {
  switch (cls) {
    case "cruiser": return 2;
    case "exotic":  return 3;
    default:        return 1;
  }
}

export function weaponMountsForShip(ship: Trader): number {
  return weaponMountsForClass(ship.shipClass);
}

// Concrete slot ids for the first N weapon mounts. Always starts with the
// primary "weapon" slot so single-mount ships work unchanged.
export function weaponSlotIds(mounts: number): UpgradeSlot[] {
  if (mounts <= 1) return ["weapon"];
  if (mounts === 2) return ["weapon", "weapon_2"];
  return ["weapon", "weapon_2", "weapon_3"];
}

// Drop a weapon-class upgrade into the first empty mount the ship has, or
// return the primary "weapon" slot when every mount is already filled (the
// caller decides whether to refuse, replace, or queue).
export function firstEmptyWeaponSlot(ship: Trader): UpgradeSlot {
  const mounts = weaponMountsForShip(ship);
  for (const slot of weaponSlotIds(mounts)) {
    if (!ship.upgrades?.[slot]) return slot;
  }
  return "weapon";
}

// Visible upgrade slots for a ship — strips out weapon mounts the ship's
// class doesn't support so the UI doesn't render orphan slots a freighter
// can never use.
export function visibleUpgradeSlots(ship: Trader): { slot: UpgradeSlot; label: string }[] {
  const mounts = weaponMountsForShip(ship);
  return UPGRADE_SLOTS.filter(entry => {
    if (entry.slot === "weapon_2") return mounts >= 2;
    if (entry.slot === "weapon_3") return mounts >= 3;
    return true;
  });
}

// Catalog notes
// -----------------------------------------------------------------------------
// IDs are preserved across the rework so existing tests, station seeds, and
// archetype loadouts keep working — only display names and the available
// variants change. New entries are gated to existing CrewModifier effects;
// new effect keys (fuel regen, docking discount, treasury yield, etc.) are
// reserved for Phase B per docs/UPGRADES_REWORK.md.
export const SHIP_UPGRADES: Record<GoodId, ShipUpgradeDef> = {
  // --- cargo --------------------------------------------------------------
  upg_cargo_1: {
    id: "upg_cargo_1", slot: "cargo", tier: 1,
    name: "Standard Cargo Bay",
    description: "Stamped-steel hold expansion. Cheap, dependable, ugly.",
    effects: { cargoCapacityBonus: 15 },
  },
  upg_cargo_modular_1: {
    id: "upg_cargo_modular_1", slot: "cargo", tier: 1,
    name: "Modular Container Bay",
    description: "Snap-in containers. Smaller hold, but loaders move fast.",
    effects: { cargoCapacityBonus: 8, unloadSpeedBonus: 0.5 },
  },
  upg_cargo_2: {
    id: "upg_cargo_2", slot: "cargo", tier: 2,
    name: "Heavy Hauler Frame",
    description: "Reinforced ribs and a wider keel for serious bulk runs.",
    effects: { cargoCapacityBonus: 35 },
  },
  upg_cargo_loader_2: {
    id: "upg_cargo_loader_2", slot: "cargo", tier: 2,
    name: "Rapid Cargo Lift",
    description: "Twin gantry arms move pallets twice as fast as crew can.",
    effects: { cargoCapacityBonus: 10, unloadSpeedBonus: 1 },
  },
  upg_cargo_smuggler_2: {
    id: "upg_cargo_smuggler_2", slot: "cargo", tier: 2,
    name: "Smuggler's Compartment",
    description: "False bulkheads and quiet tools — saves on yard fees.",
    effects: { cargoCapacityBonus: 22, maintenanceDiscount: 0.06 },
  },
  upg_cargo_3: {
    id: "upg_cargo_3", slot: "cargo", tier: 3,
    name: "Megahauler Conversion",
    description: "Re-shelled into a bulk freighter. The crew refuses to call it pretty.",
    effects: { cargoCapacityBonus: 60 },
  },
  upg_cargo_loader_3: {
    id: "upg_cargo_loader_3", slot: "cargo", tier: 3,
    name: "Zero-G Unload Matrix",
    description: "Lev-rail palletizers settle the entire hold in a single tick.",
    effects: { cargoCapacityBonus: 20, instantUnload: 1 },
  },
  upg_cargo_atlas_3: {
    id: "upg_cargo_atlas_3", slot: "cargo", tier: 4,
    name: "Atlas Hauler Spine",
    description: "Hardpoint-mounted spine adds a third hold beneath the keel.",
    effects: { cargoCapacityBonus: 90 },
  },

  // --- engine -------------------------------------------------------------
  upg_engine_1: {
    id: "upg_engine_1", slot: "engine", tier: 1,
    name: "Vector Thrusters",
    description: "Aftermarket thrust vanes. A noticeable kick off the pad.",
    effects: { speedBonus: 0.25 },
  },
  upg_engine_solar_1: {
    id: "upg_engine_solar_1", slot: "engine", tier: 1,
    name: "Solar Sail Rig",
    description: "Reflective sheets unfurl in transit. Slow gains, cheap fuel.",
    effects: { speedBonus: 0.15, rangeEfficiency: 0.10 },
  },
  upg_engine_2: {
    id: "upg_engine_2", slot: "engine", tier: 2,
    name: "Slipstream Drive",
    description: "Re-tuned plasma flow lets the ship ride lane currents cleanly.",
    effects: { speedBonus: 0.5, rangeEfficiency: 0.10 },
  },
  upg_engine_micro_2: {
    id: "upg_engine_micro_2", slot: "engine", tier: 2,
    name: "Microjump Coil",
    description: "Stutter-jump capacitor chains short hops without warming the drive.",
    effects: { speedBonus: 0.4, maintenanceDiscount: 0.06 },
  },
  upg_engine_3: {
    id: "upg_engine_3", slot: "engine", tier: 4,
    name: "FTL Fold Drive",
    description: "Folds space at the cost of a dock-side requalification.",
    effects: { speedBonus: 1, instantTravel: 1 },
  },
  upg_engine_singularity_3: {
    id: "upg_engine_singularity_3", slot: "engine", tier: 3,
    name: "Singularity Burst Drive",
    description: "Caged micro-singularity. Insane speed, conventional travel.",
    effects: { speedBonus: 1.4 },
  },

  // --- fuel ---------------------------------------------------------------
  upg_fuel_1: {
    id: "upg_fuel_1", slot: "fuel", tier: 1,
    name: "Fuel Reclaimer Pump",
    description: "Recycles vented hydrogen mist back into the main tank.",
    effects: { fuelCapacityBonus: 15, rangeEfficiency: 0.08 },
  },
  upg_fuel_solar_1: {
    id: "upg_fuel_solar_1", slot: "fuel", tier: 1,
    name: "Solar Bloom Collector",
    description: "Petals soak up light during cruise. Tiny tank, sips fuel.",
    effects: { fuelCapacityBonus: 8, rangeEfficiency: 0.12 },
  },
  upg_fuel_2: {
    id: "upg_fuel_2", slot: "fuel", tier: 2,
    name: "Hydrogen Spinner Reclaimer",
    description: "Centrifuge-grade reclamation; near-loss-free fuel cycling.",
    effects: { fuelCapacityBonus: 35, rangeEfficiency: 0.18 },
  },
  upg_fuel_aux_2: {
    id: "upg_fuel_aux_2", slot: "fuel", tier: 2,
    name: "Auxiliary Tank Lattice",
    description: "Saddle tanks bolted to the keel. Massive range, zero finesse.",
    effects: { fuelCapacityBonus: 60 },
  },
  upg_fuel_3: {
    id: "upg_fuel_3", slot: "fuel", tier: 4,
    name: "Zero-Point Fuel Core",
    description: "Exotic core taps vacuum energy. Travel costs no fuel.",
    effects: { fuelCapacityBonus: 60, fuelFreeTravel: 1 },
  },
  upg_fuel_bio_3: {
    id: "upg_fuel_bio_3", slot: "fuel", tier: 3,
    name: "Bio-Reactor Stack",
    description: "Cracks cargo waste into burnable mash. Stretches every drop.",
    effects: { fuelCapacityBonus: 30, rangeEfficiency: 0.30 },
  },

  // --- hull ---------------------------------------------------------------
  upg_hull_1: {
    id: "upg_hull_1", slot: "hull", tier: 1,
    name: "Reinforced Plating",
    description: "Thicker plates. Sleeps better in pirate sectors.",
    effects: { hullBonus: 1 },
  },
  upg_hull_2: {
    id: "upg_hull_2", slot: "hull", tier: 2,
    name: "Composite Battle Plating",
    description: "Layered ceramic-iridium weave. Rated for sustained fire.",
    effects: { hullBonus: 2, maintenanceDiscount: 0.05 },
  },
  upg_hull_ablative_2: {
    id: "upg_hull_ablative_2", slot: "hull", tier: 2,
    name: "Ablative Plate Layers",
    description: "Sacrificial outer skin sloughs off in combat. Cheap to refit.",
    effects: { hullBonus: 3, maintenanceDiscount: 0.04 },
  },
  upg_hull_stealth_2: {
    id: "upg_hull_stealth_2", slot: "hull", tier: 2,
    name: "Photon Damping Coat",
    description: "Anechoic skin makes the ship look smaller on scanners.",
    effects: { hullBonus: 1, contractRewardBonus: 0.06 },
  },
  upg_hull_3: {
    id: "upg_hull_3", slot: "hull", tier: 3,
    name: "Adamant Carapace",
    description: "Forged mono-plate shell. Survives most boarding scenarios.",
    effects: { hullBonus: 4, maintenanceDiscount: 0.10 },
  },
  upg_hull_nano_3: {
    id: "upg_hull_nano_3", slot: "hull", tier: 4,
    name: "Self-Repair Nanite Mesh",
    description: "Skin knits itself between trips. Maintenance is almost free.",
    effects: { hullBonus: 3, maintenanceDiscount: 0.20 },
  },

  // --- weapons ------------------------------------------------------------
  upg_weapon_1: {
    id: "upg_weapon_1", slot: "weapon", tier: 1,
    name: "Pulse Cannon Turret",
    description: "Standard kinetic mount. Loud, reliable, popular with pirates.",
    effects: { weaponPowerBonus: 1 },
  },
  upg_weapon_defense_1: {
    id: "upg_weapon_defense_1", slot: "weapon", tier: 1,
    name: "Point-Defense Lattice",
    description: "Auto-tracking flak grid trims maintenance from light skirmishes.",
    effects: { weaponPowerBonus: 1, maintenanceDiscount: 0.04 },
  },
  upg_weapon_2: {
    id: "upg_weapon_2", slot: "weapon", tier: 2,
    name: "Quad Gauss Battery",
    description: "Four-rail magnetics — buyers pay extra for heavy escort runs.",
    effects: { weaponPowerBonus: 3, contractRewardBonus: 0.05 },
  },
  upg_weapon_bounty_2: {
    id: "upg_weapon_bounty_2", slot: "weapon", tier: 2,
    name: "Bounty Hunter Rig",
    description: "Identi-tag harpoons let stations price your contracts higher.",
    effects: { weaponPowerBonus: 3, contractRewardBonus: 0.08 },
  },
  upg_weapon_3: {
    id: "upg_weapon_3", slot: "weapon", tier: 4,
    name: "Plasma Lance Array",
    description: "Forward lance + dorsal turret cluster. Almost certainly illegal somewhere.",
    effects: { weaponPowerBonus: 6, contractRewardBonus: 0.10 },
  },
  upg_weapon_emp_3: {
    id: "upg_weapon_emp_3", slot: "weapon", tier: 3,
    name: "EMP Disruptor Array",
    description: "Wide-cone EMP discourages pursuit; saves fuel on long runs.",
    effects: { weaponPowerBonus: 4, rangeEfficiency: 0.10 },
  },

  // --- systems ------------------------------------------------------------
  upg_systems_nav_1: {
    id: "upg_systems_nav_1", slot: "systems", tier: 1,
    name: "Survey Computer",
    description: "Live scanner package. Tasking boards show you fatter rewards.",
    effects: { contractRewardBonus: 0.03 },
  },
  upg_systems_haggler_1: {
    id: "upg_systems_haggler_1", slot: "systems", tier: 1,
    name: "Haggler's Earpiece",
    description: "AI negotiator whispers counter-offers in your ear.",
    effects: { contractRewardBonus: 0.05 },
  },
  upg_systems_exchange_2: {
    id: "upg_systems_exchange_2", slot: "systems", tier: 2,
    name: "Exchange Relay",
    description: "Direct quantum link to filled orders — settlements arrive instantly.",
    effects: { remoteSettlementCollection: 1 },
  },
  upg_systems_ticker_2: {
    id: "upg_systems_ticker_2", slot: "systems", tier: 2,
    name: "Bridge Ticker Tape",
    description: "Live commodity feed nudges contract pricing in your favor.",
    effects: { contractRewardBonus: 0.06 },
  },
  upg_systems_oracle_3: {
    id: "upg_systems_oracle_3", slot: "systems", tier: 4,
    name: "Oracle Trade Core",
    description: "Predictive market AI. Stations open the books a little wider.",
    effects: { remoteSettlementCollection: 1, contractRewardBonus: 0.12, sellPremium: 0.03 },
  },
  upg_systems_pressure_3: {
    id: "upg_systems_pressure_3", slot: "systems", tier: 3,
    name: "Pressure Atlas Console",
    description: "Sector-wide shortage map; shaves costs and fattens contracts.",
    effects: { contractRewardBonus: 0.10, maintenanceDiscount: 0.06 },
  },

  // --- phase B: variants that exercise the new effect keys ----------------
  // (also a couple that wire up buyDiscount / sellPremium since those keys
  // were defined but unused before phase B.)
  upg_fuel_regen_2: {
    id: "upg_fuel_regen_2", slot: "fuel", tier: 2,
    name: "Hyperion Bloom Reclaimer",
    description: "Soaks ambient gases at dock; tank slowly tops itself up.",
    effects: { fuelCapacityBonus: 18, fuelRegenIdle: 0.5 },
  },
  upg_systems_treasury_2: {
    id: "upg_systems_treasury_2", slot: "systems", tier: 2,
    name: "Bonded Treasury Module",
    description: "Sweeps idle cash into station bonds for a tiny per-tick yield.",
    effects: { treasuryYield: 0.0008, contractRewardBonus: 0.04 },
  },
  upg_systems_dock_2: {
    id: "upg_systems_dock_2", slot: "systems", tier: 2,
    name: "Diplomatic Beacon",
    description: "Posh credentials; harbormasters cut your docking fee.",
    effects: { dockingDiscount: 0.30 },
  },
  upg_systems_dividend_3: {
    id: "upg_systems_dividend_3", slot: "systems", tier: 3,
    name: "Shareholder Relations Suite",
    description: "Investor-grade comms; every dividend pays a little extra.",
    effects: { dividendBonus: 0.12, treasuryYield: 0.0005 },
  },
  upg_systems_haggler_2: {
    id: "upg_systems_haggler_2", slot: "systems", tier: 2,
    name: "Negotiator's Console",
    description: "AI counters every bid. Stations price you a touch lower, pay you a touch higher.",
    effects: { buyDiscount: 0.04, sellPremium: 0.04 },
  },
};

export function isUpgradeGood(good: GoodId): boolean {
  return SHIP_UPGRADES[good] != null;
}

export function upgradeDef(good: GoodId): ShipUpgradeDef | null {
  return SHIP_UPGRADES[good] ?? null;
}

export function upgradeStars(tier: UpgradeTier): string {
  return "★".repeat(tier);
}

export function combinedUpgradeModifiers(slots: ShipUpgradeSlots | undefined): CrewModifiers {
  const acc: CrewModifiers = {};
  if (!slots) return acc;
  for (const goodId of Object.values(slots)) {
    if (!goodId) continue;
    const def = SHIP_UPGRADES[goodId];
    if (!def) continue;
    for (const [key, value] of Object.entries(def.effects) as [keyof CrewModifiers, number][]) {
      if (!value) continue;
      acc[key] = ((acc[key] ?? 0) + value) as never;
    }
  }
  return acc;
}

export function upgradeEffectText(def: ShipUpgradeDef): string {
  const effects = def.effects;
  const parts: string[] = [];
  if (effects.cargoCapacityBonus) parts.push(`+${effects.cargoCapacityBonus} cargo`);
  if (effects.fuelCapacityBonus) parts.push(`+${effects.fuelCapacityBonus} fuel`);
  if (effects.speedBonus) parts.push(`+${effects.speedBonus} speed`);
  if (effects.hullBonus) parts.push(`+${effects.hullBonus} hull`);
  if (effects.weaponPowerBonus) parts.push(`+${effects.weaponPowerBonus} weapons`);
  if (effects.rangeEfficiency) parts.push(`−${(effects.rangeEfficiency * 100).toFixed(0)}% fuel/dist`);
  if (effects.unloadSpeedBonus) parts.push(`+${(effects.unloadSpeedBonus * 100).toFixed(0)}% unload speed`);
  if (effects.instantUnload) parts.push("instant unload");
  if (effects.remoteSettlementCollection) parts.push("remote exchange collection");
  if (effects.instantTravel) parts.push("FTL instant travel");
  if (effects.fuelFreeTravel) parts.push("fuel-free travel");
  if (effects.buyDiscount) parts.push(`−${(effects.buyDiscount * 100).toFixed(0)}% buy`);
  if (effects.sellPremium) parts.push(`+${(effects.sellPremium * 100).toFixed(0)}% sell`);
  if (effects.maintenanceDiscount) parts.push(`−${(effects.maintenanceDiscount * 100).toFixed(0)}% maintenance`);
  if (effects.contractRewardBonus) parts.push(`+${(effects.contractRewardBonus * 100).toFixed(0)}% contracts`);
  if (effects.dockingDiscount) parts.push(`−${(effects.dockingDiscount * 100).toFixed(0)}% docking`);
  if (effects.fuelRegenIdle) parts.push(`+${effects.fuelRegenIdle.toFixed(1)} fuel/tick docked`);
  if (effects.treasuryYield) parts.push(`+${(effects.treasuryYield * 100).toFixed(2)}%/tick yield`);
  if (effects.dividendBonus) parts.push(`+${(effects.dividendBonus * 100).toFixed(0)}% dividends`);
  return parts.join(" · ");
}

export function installedUpgrade(ship: Trader, slot: UpgradeSlot): ShipUpgradeDef | null {
  const good = ship.upgrades?.[slot];
  return good ? upgradeDef(good) : null;
}
