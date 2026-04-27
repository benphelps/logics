import type { CrewModifiers, GoodId, ShipUpgradeSlots, Trader, UpgradeSlot, UpgradeTier } from "./types";

export interface ShipUpgradeDef {
  id: GoodId;
  slot: UpgradeSlot;
  tier: UpgradeTier;
  name: string;
  effects: CrewModifiers;
}

export const UPGRADE_SLOTS: { slot: UpgradeSlot; label: string }[] = [
  { slot: "cargo", label: "Cargo Hold" },
  { slot: "engine", label: "Engines" },
  { slot: "fuel", label: "Fuel Tanks" },
  { slot: "hull", label: "Hull" },
  { slot: "weapon", label: "Weapons" },
];

export const SHIP_UPGRADES: Record<GoodId, ShipUpgradeDef> = {
  upg_cargo_1: { id: "upg_cargo_1", slot: "cargo", tier: 1, name: "Cargo Bay Extension I", effects: { cargoCapacityBonus: 15 } },
  upg_cargo_2: { id: "upg_cargo_2", slot: "cargo", tier: 2, name: "Cargo Bay Extension II", effects: { cargoCapacityBonus: 35 } },
  upg_cargo_3: { id: "upg_cargo_3", slot: "cargo", tier: 3, name: "Cargo Bay Extension III", effects: { cargoCapacityBonus: 60 } },

  upg_engine_1: { id: "upg_engine_1", slot: "engine", tier: 1, name: "Engine Tuning Kit I", effects: { speedBonus: 0.25 } },
  upg_engine_2: { id: "upg_engine_2", slot: "engine", tier: 2, name: "Engine Tuning Kit II", effects: { speedBonus: 0.5 } },
  upg_engine_3: { id: "upg_engine_3", slot: "engine", tier: 3, name: "Engine Tuning Kit III", effects: { speedBonus: 1 } },

  upg_fuel_1: { id: "upg_fuel_1", slot: "fuel", tier: 1, name: "Auxiliary Fuel Tank I", effects: { fuelCapacityBonus: 15 } },
  upg_fuel_2: { id: "upg_fuel_2", slot: "fuel", tier: 2, name: "Auxiliary Fuel Tank II", effects: { fuelCapacityBonus: 35 } },
  upg_fuel_3: { id: "upg_fuel_3", slot: "fuel", tier: 3, name: "Auxiliary Fuel Tank III", effects: { fuelCapacityBonus: 60 } },

  upg_hull_1: { id: "upg_hull_1", slot: "hull", tier: 1, name: "Reinforced Hull Plating I", effects: { hullBonus: 1 } },
  upg_hull_2: { id: "upg_hull_2", slot: "hull", tier: 2, name: "Reinforced Hull Plating II", effects: { hullBonus: 2 } },
  upg_hull_3: { id: "upg_hull_3", slot: "hull", tier: 3, name: "Reinforced Hull Plating III", effects: { hullBonus: 4 } },

  upg_weapon_1: { id: "upg_weapon_1", slot: "weapon", tier: 1, name: "Light Weapon Mount I", effects: { weaponPowerBonus: 1 } },
  upg_weapon_2: { id: "upg_weapon_2", slot: "weapon", tier: 2, name: "Medium Weapon Mount II", effects: { weaponPowerBonus: 3 } },
  upg_weapon_3: { id: "upg_weapon_3", slot: "weapon", tier: 3, name: "Heavy Weapon Mount III", effects: { weaponPowerBonus: 6 } },
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
    const m = def.effects;
    if (m.cargoCapacityBonus) acc.cargoCapacityBonus = (acc.cargoCapacityBonus ?? 0) + m.cargoCapacityBonus;
    if (m.fuelCapacityBonus) acc.fuelCapacityBonus = (acc.fuelCapacityBonus ?? 0) + m.fuelCapacityBonus;
    if (m.speedBonus) acc.speedBonus = (acc.speedBonus ?? 0) + m.speedBonus;
    if (m.hullBonus) acc.hullBonus = (acc.hullBonus ?? 0) + m.hullBonus;
    if (m.weaponPowerBonus) acc.weaponPowerBonus = (acc.weaponPowerBonus ?? 0) + m.weaponPowerBonus;
    if (m.rangeEfficiency) acc.rangeEfficiency = (acc.rangeEfficiency ?? 0) + m.rangeEfficiency;
    if (m.buyDiscount) acc.buyDiscount = (acc.buyDiscount ?? 0) + m.buyDiscount;
    if (m.sellPremium) acc.sellPremium = (acc.sellPremium ?? 0) + m.sellPremium;
    if (m.maintenanceDiscount) acc.maintenanceDiscount = (acc.maintenanceDiscount ?? 0) + m.maintenanceDiscount;
    if (m.contractRewardBonus) acc.contractRewardBonus = (acc.contractRewardBonus ?? 0) + m.contractRewardBonus;
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
  return parts.join(" · ");
}

export function installedUpgrade(ship: Trader, slot: UpgradeSlot): ShipUpgradeDef | null {
  const good = ship.upgrades?.[slot];
  return good ? upgradeDef(good) : null;
}
