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
  { slot: "systems", label: "Ship Systems" },
];

export const SHIP_UPGRADES: Record<GoodId, ShipUpgradeDef> = {
  upg_cargo_1: { id: "upg_cargo_1", slot: "cargo", tier: 1, name: "Cargo Bay Extension I", effects: { cargoCapacityBonus: 15 } },
  upg_cargo_2: { id: "upg_cargo_2", slot: "cargo", tier: 2, name: "Cargo Bay Extension II", effects: { cargoCapacityBonus: 35 } },
  upg_cargo_3: { id: "upg_cargo_3", slot: "cargo", tier: 3, name: "Cargo Bay Extension III", effects: { cargoCapacityBonus: 60 } },
  upg_cargo_loader_2: { id: "upg_cargo_loader_2", slot: "cargo", tier: 2, name: "Rapid Cargo Lift II", effects: { cargoCapacityBonus: 10, unloadSpeedBonus: 1 } },
  upg_cargo_loader_3: { id: "upg_cargo_loader_3", slot: "cargo", tier: 3, name: "Zero-G Unload Matrix III", effects: { cargoCapacityBonus: 20, instantUnload: 1 } },

  upg_engine_1: { id: "upg_engine_1", slot: "engine", tier: 1, name: "Vector Thrusters I", effects: { speedBonus: 0.25 } },
  upg_engine_2: { id: "upg_engine_2", slot: "engine", tier: 2, name: "Slipstream Drive II", effects: { speedBonus: 0.5, rangeEfficiency: 0.1 } },
  upg_engine_3: { id: "upg_engine_3", slot: "engine", tier: 3, name: "FTL Fold Drive III", effects: { speedBonus: 1, instantTravel: 1 } },

  upg_fuel_1: { id: "upg_fuel_1", slot: "fuel", tier: 1, name: "Fuel Reclaimer I", effects: { fuelCapacityBonus: 15, rangeEfficiency: 0.08 } },
  upg_fuel_2: { id: "upg_fuel_2", slot: "fuel", tier: 2, name: "Fuel Reclaimer II", effects: { fuelCapacityBonus: 35, rangeEfficiency: 0.18 } },
  upg_fuel_3: { id: "upg_fuel_3", slot: "fuel", tier: 3, name: "Zero-Point Fuel Core III", effects: { fuelCapacityBonus: 60, fuelFreeTravel: 1 } },

  upg_hull_1: { id: "upg_hull_1", slot: "hull", tier: 1, name: "Reinforced Hull Plating I", effects: { hullBonus: 1 } },
  upg_hull_2: { id: "upg_hull_2", slot: "hull", tier: 2, name: "Reinforced Hull Plating II", effects: { hullBonus: 2, maintenanceDiscount: 0.05 } },
  upg_hull_3: { id: "upg_hull_3", slot: "hull", tier: 3, name: "Reinforced Hull Plating III", effects: { hullBonus: 4, maintenanceDiscount: 0.1 } },

  upg_weapon_1: { id: "upg_weapon_1", slot: "weapon", tier: 1, name: "Light Weapon Mount I", effects: { weaponPowerBonus: 1 } },
  upg_weapon_2: { id: "upg_weapon_2", slot: "weapon", tier: 2, name: "Medium Weapon Mount II", effects: { weaponPowerBonus: 3, contractRewardBonus: 0.05 } },
  upg_weapon_3: { id: "upg_weapon_3", slot: "weapon", tier: 3, name: "Heavy Weapon Mount III", effects: { weaponPowerBonus: 6, contractRewardBonus: 0.1 } },

  upg_systems_nav_1: { id: "upg_systems_nav_1", slot: "systems", tier: 1, name: "Survey Computer I", effects: { contractRewardBonus: 0.03 } },
  upg_systems_exchange_2: { id: "upg_systems_exchange_2", slot: "systems", tier: 2, name: "Exchange Relay II", effects: { remoteSettlementCollection: 1 } },
  upg_systems_oracle_3: { id: "upg_systems_oracle_3", slot: "systems", tier: 3, name: "Oracle Trade Core III", effects: { remoteSettlementCollection: 1, contractRewardBonus: 0.12, sellPremium: 0.03 } },
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
  return parts.join(" · ");
}

export function installedUpgrade(ship: Trader, slot: UpgradeSlot): ShipUpgradeDef | null {
  const good = ship.upgrades?.[slot];
  return good ? upgradeDef(good) : null;
}
