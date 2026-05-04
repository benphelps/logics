// Shipyards — stations of kind "shipyard" sell ship blueprints. The
// player can buy a new ship at one, paying from the docked ship's
// wallet; the new ship is minted as a Trader, added to the player's
// fleet, and starts docked at the same shipyard with its own empty
// wallet. Inventory cycles like crew offers / jobs: capped per yard,
// expires after a window, posts a fresh blueprint each tick when
// space allows.

import { recomputeShipStats } from "./crew";
import { generateShipName } from "./gen/names";
import type { Rng } from "./gen/rng";
import { mulberry32, pick, rangeFloat, rangeInt } from "./gen/rng";
import type {
  GoodId,
  LocationDef,
  LocationId,
  ShipBlueprint,
  ShipClass,
  ShipTrait,
  ShipUpgradeSlots,
  Trader,
  TraderId,
  World,
} from "./types";
import { isUpgradeGood, upgradeDef } from "./upgrades";

// Inventory-tuning constants, mirroring the hires module's cadence
// so a player docked at a yard sees something refresh on a comparable
// timescale to crew offers.
export const SHIPYARD_MAX_INVENTORY = 4;
export const SHIPYARD_BLUEPRINT_LIFETIME = 1200;     // ticks before a blueprint expires unsold
export const SHIPYARD_POST_CHANCE = 0.04;            // per-yard, per-tick chance to mint when space
export const SHIPYARD_INITIAL_FILL = 3;              // pre-fill on first sighting so the UI isn't empty
const SHIPYARD_RNG_SEED = 0x5179a4d;                 // distinct from hires/world seeds

// --- Class templates ---------------------------------------------------

interface ClassTemplate {
  label: string;
  baseCapacity: [number, number];
  baseSpeed: [number, number];
  baseFuelCapacity: [number, number];
  baseHull: [number, number];
  baseWeaponPower: [number, number];
  fuelTypes: GoodId[];
  basePrice: [number, number];                       // raw class price, pre stat/upgrade adjustments
  preInstalledTiers: { 1: [number, number]; 2: [number, number]; 3?: [number, number] };
  // Pool of upgrade ids that fit this class — the blueprint generator
  // randomly picks 0-N from the matching slot bucket.
  upgradePool: { slot: keyof ShipUpgradeSlots; ids: GoodId[] }[];
  // Trait-roll weights — chance per trait that the rolled blueprint
  // ships with that perk baked in.
  traitWeights: Partial<Record<ShipTrait, number>>;
  flavor: string[];
}

const CLASS_TEMPLATES: Record<ShipClass, ClassTemplate> = {
  freighter: {
    label: "Freighter",
    baseCapacity: [80, 130],
    baseSpeed: [0.9, 1.2],
    baseFuelCapacity: [55, 85],
    baseHull: [4, 6],
    baseWeaponPower: [0, 1],
    fuelTypes: ["plasma", "antimatter"],
    basePrice: [2_200_000, 4_500_000],
    preInstalledTiers: { 1: [1, 2], 2: [0, 1] },
    upgradePool: [
      { slot: "cargo", ids: ["upg_cargo_1", "upg_cargo_modular_1", "upg_cargo_2"] },
      { slot: "engine", ids: ["upg_engine_1", "upg_engine_solar_1", "upg_engine_2"] },
      { slot: "fuel", ids: ["upg_fuel_1", "upg_fuel_2"] },
      { slot: "hull", ids: ["upg_hull_1", "upg_hull_2"] },
      { slot: "systems", ids: ["upg_systems_nav_1", "upg_systems_exchange_2"] },
    ],
    traitWeights: { "fuel-efficient": 0.18, "rapid-unload": 0.14 },
    flavor: [
      "Workhorse mid-haul freighter. Forgettable, dependable, profitable.",
      "Standard issue freighter — easy to crew, easy to insure.",
      "Mid-tonnage freighter with a quiet engine note and a square hold.",
    ],
  },
  courier: {
    label: "Courier",
    baseCapacity: [25, 50],
    baseSpeed: [1.6, 2.4],
    baseFuelCapacity: [25, 45],
    baseHull: [2, 4],
    baseWeaponPower: [0, 1],
    fuelTypes: ["plasma", "antimatter"],
    basePrice: [1_400_000, 3_200_000],
    preInstalledTiers: { 1: [1, 2], 2: [0, 1] },
    upgradePool: [
      { slot: "engine", ids: ["upg_engine_1", "upg_engine_solar_1", "upg_engine_2", "upg_engine_3"] },
      { slot: "fuel", ids: ["upg_fuel_1", "upg_fuel_2"] },
      { slot: "hull", ids: ["upg_hull_1"] },
      { slot: "systems", ids: ["upg_systems_nav_1", "upg_systems_exchange_2"] },
    ],
    traitWeights: { "fuel-efficient": 0.30, "ai-navigator": 0.10 },
    flavor: [
      "Slim courier hull — runs hot, lands fast, never overpacks.",
      "Whisper-class courier. Lighter than gravity says it should be.",
      "Pilot-shaped cockpit, freighter-shaped wallet.",
    ],
  },
  hauler: {
    label: "Hauler",
    baseCapacity: [140, 220],
    baseSpeed: [0.7, 1.05],
    baseFuelCapacity: [70, 110],
    baseHull: [5, 8],
    baseWeaponPower: [0, 2],
    fuelTypes: ["plasma", "antimatter"],
    basePrice: [3_400_000, 6_500_000],
    preInstalledTiers: { 1: [1, 2], 2: [1, 2], 3: [0, 1] },
    upgradePool: [
      { slot: "cargo", ids: ["upg_cargo_1", "upg_cargo_2", "upg_cargo_3", "upg_cargo_loader_2", "upg_cargo_loader_3"] },
      { slot: "engine", ids: ["upg_engine_1", "upg_engine_2"] },
      { slot: "fuel", ids: ["upg_fuel_1", "upg_fuel_2", "upg_fuel_3"] },
      { slot: "hull", ids: ["upg_hull_1", "upg_hull_2", "upg_hull_3"] },
      { slot: "systems", ids: ["upg_systems_nav_1"] },
    ],
    traitWeights: { "rapid-unload": 0.30, "extra-slot": 0.08 },
    flavor: [
      "Heavy hauler. Fits more than the dock crew has shifts to unload.",
      "Long-keel cargo lifter — slow on the burn, brutal on the manifest.",
      "Two thrusters, three bulk holds, and a coffee maker bolted to the wall.",
    ],
  },
  cruiser: {
    label: "Cruiser",
    baseCapacity: [60, 100],
    baseSpeed: [1.1, 1.5],
    baseFuelCapacity: [50, 90],
    baseHull: [7, 10],
    baseWeaponPower: [3, 6],
    fuelTypes: ["antimatter", "plasma"],
    basePrice: [4_400_000, 8_800_000],
    preInstalledTiers: { 1: [1, 2], 2: [1, 2], 3: [0, 1] },
    upgradePool: [
      { slot: "engine", ids: ["upg_engine_1", "upg_engine_2", "upg_engine_3"] },
      { slot: "fuel", ids: ["upg_fuel_2", "upg_fuel_3"] },
      { slot: "hull", ids: ["upg_hull_2", "upg_hull_3"] },
      // Two weapon mounts. Each rolls independently in the pre-install
      // pass so a cruiser can ship with one or both turrets armed.
      { slot: "weapon", ids: ["upg_weapon_1", "upg_weapon_defense_1", "upg_weapon_2"] },
      { slot: "weapon_2", ids: ["upg_weapon_1", "upg_weapon_defense_1", "upg_weapon_2"] },
      { slot: "systems", ids: ["upg_systems_nav_1", "upg_systems_exchange_2", "upg_systems_oracle_3"] },
    ],
    traitWeights: { "ai-navigator": 0.15, "extra-slot": 0.10 },
    flavor: [
      "Cruiser-class hull — heavy plate, room to bolt teeth on.",
      "Dual-thruster armed cruiser. Built for runs the courier wouldn't take.",
      "Designed to come back from the runs no one else came back from.",
    ],
  },
  exotic: {
    label: "Exotic",
    baseCapacity: [50, 90],
    baseSpeed: [1.4, 1.9],
    baseFuelCapacity: [40, 70],
    baseHull: [4, 6],
    baseWeaponPower: [2, 4],
    fuelTypes: ["antimatter", "plasma"],
    basePrice: [6_500_000, 14_500_000],
    preInstalledTiers: { 1: [0, 1], 2: [1, 2], 3: [1, 2] },
    upgradePool: [
      { slot: "engine", ids: ["upg_engine_2", "upg_engine_3"] },
      { slot: "fuel", ids: ["upg_fuel_2", "upg_fuel_3"] },
      { slot: "hull", ids: ["upg_hull_2", "upg_hull_3"] },
      { slot: "cargo", ids: ["upg_cargo_loader_3"] },
      // Three weapon mounts — exotics are the apex combat hull.
      { slot: "weapon", ids: ["upg_weapon_2", "upg_weapon_3", "upg_weapon_emp_3"] },
      { slot: "weapon_2", ids: ["upg_weapon_2", "upg_weapon_3", "upg_weapon_bounty_2"] },
      { slot: "weapon_3", ids: ["upg_weapon_2", "upg_weapon_emp_3"] },
      { slot: "systems", ids: ["upg_systems_oracle_3"] },
    ],
    // Exotics carry the headline self-piloted / AI-navigator perks at
    // notably higher rates — they're the "ship that thinks for itself"
    // story-line ships. Player still has the pilot+navigator slots,
    // they just don't need to be filled to operate.
    traitWeights: {
      "self-piloted": 0.40,
      "ai-navigator": 0.30,
      "extra-slot": 0.20,
      "fuel-efficient": 0.20,
    },
    flavor: [
      "Limited-run exotic. Reads engine telemetry like it's reading you.",
      "Custom-fab exotic — reinforced, instrumented, and quietly autonomous.",
      "Prototype hull. Half lab specimen, half ship.",
    ],
  },
};

const CLASS_WEIGHTS: { class: ShipClass; weight: number }[] = [
  { class: "freighter", weight: 0.32 },
  { class: "courier",   weight: 0.22 },
  { class: "hauler",    weight: 0.20 },
  { class: "cruiser",   weight: 0.16 },
  { class: "exotic",    weight: 0.10 },
];

// --- generation --------------------------------------------------------

function pickClass(rng: Rng): ShipClass {
  const r = rng();
  let acc = 0;
  for (const entry of CLASS_WEIGHTS) {
    acc += entry.weight;
    if (r < acc) return entry.class;
  }
  return "freighter";
}

function rollPreInstalled(rng: Rng, template: ClassTemplate, techLevel: number): ShipUpgradeSlots {
  const out: ShipUpgradeSlots = {};
  // Filter the pool to the slots this template offers, then pick from
  // each at random. Tier-3 upgrades only roll if the shipyard's tech
  // level supports them.
  for (const bucket of template.upgradePool) {
    if (rng() > 0.55) continue;                      // not every slot is filled
    const candidates = bucket.ids.filter(id => {
      const def = upgradeDef(id);
      if (!def) return false;
      if (def.tier >= 3 && techLevel < 7) return false;
      return true;
    });
    if (candidates.length === 0) continue;
    out[bucket.slot] = pick(rng, candidates) as GoodId;
  }
  return out;
}

function rollTraits(rng: Rng, template: ClassTemplate): ShipTrait[] {
  const traits: ShipTrait[] = [];
  for (const [trait, chance] of Object.entries(template.traitWeights) as [ShipTrait, number][]) {
    if (rng() < chance) traits.push(trait);
  }
  return traits;
}

function pricedAt(rng: Rng, template: ClassTemplate, preInstalled: ShipUpgradeSlots, traits: ShipTrait[]): number {
  const base = rangeInt(rng, template.basePrice[0], template.basePrice[1]);
  let mult = 1;
  // Pre-installed upgrades each tack on ~12-25% based on tier.
  for (const id of Object.values(preInstalled)) {
    const def = id ? upgradeDef(id) : null;
    if (!def) continue;
    mult += 0.10 + def.tier * 0.06;
  }
  // Headline perks compound the markup quickly — these are the
  // expensive-to-engineer bits.
  if (traits.includes("self-piloted")) mult += 0.45;
  if (traits.includes("ai-navigator")) mult += 0.30;
  if (traits.includes("extra-slot"))   mult += 0.25;
  if (traits.includes("fuel-efficient")) mult += 0.10;
  if (traits.includes("rapid-unload"))   mult += 0.08;
  return Math.round(base * mult / 10000) * 10000;    // round to 10k for tidy display
}

function generateBlueprint(rng: Rng, station: LocationDef, world: World): ShipBlueprint {
  const cls = pickClass(rng);
  const template = CLASS_TEMPLATES[cls];
  const techLevel = station.traits.techLevel;
  const used = new Set<string>(Object.values(world.traders).map(t => t.id));
  // Add existing blueprint names so we don't repeat across the
  // shipyard's current inventory.
  for (const inv of Object.values(world.shipyardInventory ?? {})) {
    for (const bp of inv) used.add(`t_${bp.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`);
  }
  const { name } = generateShipName(rng, used);
  const preInstalled = rollPreInstalled(rng, template, techLevel);
  const traits = rollTraits(rng, template);
  const price = pricedAt(rng, template, preInstalled, traits);
  const fuelType = pick(rng, template.fuelTypes) as GoodId;
  const flavor = pick(rng, template.flavor);
  const id = `bp_${cls}_${(world.nextShipBlueprintId ?? 0) + 1}`;
  if (world.nextShipBlueprintId == null) world.nextShipBlueprintId = 0;
  world.nextShipBlueprintId += 1;

  return {
    id,
    locationId: station.id,
    name,
    class: cls,
    classLabel: template.label,
    flavor,
    baseCapacity: rangeInt(rng, template.baseCapacity[0], template.baseCapacity[1]),
    baseSpeed: Number(rangeFloat(rng, template.baseSpeed[0], template.baseSpeed[1]).toFixed(2)),
    baseFuelCapacity: rangeInt(rng, template.baseFuelCapacity[0], template.baseFuelCapacity[1]),
    baseHull: rangeInt(rng, template.baseHull[0], template.baseHull[1]),
    baseWeaponPower: rangeInt(rng, template.baseWeaponPower[0], template.baseWeaponPower[1]),
    fuelType,
    preInstalled,
    traits,
    price,
    postedTick: world.tick,
    expiresAtTick: world.tick + SHIPYARD_BLUEPRINT_LIFETIME,
  };
}

// --- per-tick step ------------------------------------------------------

export function tickShipyards(world: World): { posted: number; expired: number } {
  if (!world.shipyardInventory) world.shipyardInventory = {};
  const inventory = world.shipyardInventory;
  const rng = mulberry32(SHIPYARD_RNG_SEED + world.tick);

  // Expire stale blueprints first, then post fresh ones if there's room.
  let expired = 0;
  for (const locId of Object.keys(inventory)) {
    const before = inventory[locId].length;
    inventory[locId] = inventory[locId].filter(bp => bp.expiresAtTick > world.tick);
    expired += before - inventory[locId].length;
  }

  let posted = 0;
  for (const station of Object.values(world.locations)) {
    if (!station.traits.tags.includes("shipyard")) continue;
    const list = inventory[station.id] ?? (inventory[station.id] = []);
    if (list.length >= SHIPYARD_MAX_INVENTORY) continue;
    // First sighting of a new shipyard pre-fills a small inventory so
    // the UI isn't empty when the player docks for the first time.
    const targetMin = list.length === 0 ? Math.min(SHIPYARD_INITIAL_FILL, SHIPYARD_MAX_INVENTORY) : list.length + 1;
    while (list.length < targetMin) {
      list.push(generateBlueprint(rng, station, world));
      posted += 1;
      if (list.length === targetMin && list.length > 0 && list.length < SHIPYARD_MAX_INVENTORY) {
        // Initial-fill loop continues until we hit targetMin; no extra
        // chance roll needed.
        break;
      }
    }
    if (list.length >= SHIPYARD_MAX_INVENTORY) continue;
    if (rng() < SHIPYARD_POST_CHANCE) {
      list.push(generateBlueprint(rng, station, world));
      posted += 1;
    }
  }

  return { posted, expired };
}

// --- queries ------------------------------------------------------------

export function listShipyardInventory(world: World, locationId: LocationId): ShipBlueprint[] {
  return world.shipyardInventory?.[locationId] ?? [];
}

export function findBlueprint(world: World, blueprintId: string): { blueprint: ShipBlueprint; locationId: LocationId } | null {
  const inv = world.shipyardInventory;
  if (!inv) return null;
  for (const [locId, list] of Object.entries(inv)) {
    const bp = list.find(b => b.id === blueprintId);
    if (bp) return { blueprint: bp, locationId: locId };
  }
  return null;
}

// --- purchase action ----------------------------------------------------

export type PurchaseShipResult =
  | { ok: true; shipId: TraderId; cashFlow: number }
  | { ok: false; reason: string };

export function purchaseShip(world: World, blueprintId: string, buyerShipId: TraderId): PurchaseShipResult {
  if (!world.player) return { ok: false, reason: "No player." };
  if (!world.player.shipIds.includes(buyerShipId)) {
    return { ok: false, reason: "Buyer ship is not in your fleet." };
  }
  const buyer = world.traders[buyerShipId];
  if (!buyer) return { ok: false, reason: "Buyer ship not found." };
  if (buyer.state !== "idle") return { ok: false, reason: "Buy ships only while docked." };

  const found = findBlueprint(world, blueprintId);
  if (!found) return { ok: false, reason: "Blueprint not on the market anymore." };
  const { blueprint, locationId } = found;
  if (buyer.location !== locationId) {
    return { ok: false, reason: "Dock at the shipyard with the buying ship to take delivery." };
  }
  if (buyer.funds < blueprint.price) {
    return {
      ok: false,
      reason: `Need Ç${blueprint.price.toLocaleString()}, this ship has Ç${Math.floor(buyer.funds).toLocaleString()}.`,
    };
  }

  // Mint the new ship from the blueprint and dock it at the same yard.
  // Each ship has its own wallet — the new one starts at 0 (the buyer
  // can transfer funds via cargo runs / future treasury feature). This
  // keeps the "only achievements are shared" rule clean: every ship is
  // financially independent from minute one.
  const newShip = mintShipFromBlueprint(blueprint, locationId, world);
  world.traders[newShip.id] = newShip;
  world.player.shipIds.push(newShip.id);
  buyer.funds -= blueprint.price;

  // Drop the blueprint off the shop so the same one isn't sold twice.
  const inv = world.shipyardInventory?.[locationId];
  if (inv) {
    const idx = inv.findIndex(b => b.id === blueprintId);
    if (idx >= 0) inv.splice(idx, 1);
  }

  return { ok: true, shipId: newShip.id, cashFlow: -blueprint.price };
}

function mintShipFromBlueprint(blueprint: ShipBlueprint, locationId: LocationId, world: World): Trader {
  const id = uniqueShipId(blueprint, world);
  const trader: Trader = {
    id,
    name: blueprint.name,
    capacity: blueprint.baseCapacity,
    speed: blueprint.baseSpeed,
    fuelCapacity: blueprint.baseFuelCapacity,
    baseCapacity: blueprint.baseCapacity,
    baseSpeed: blueprint.baseSpeed,
    baseFuelCapacity: blueprint.baseFuelCapacity,
    baseHull: blueprint.baseHull,
    baseWeaponPower: blueprint.baseWeaponPower,
    hull: blueprint.baseHull,
    weaponPower: blueprint.baseWeaponPower,
    upgrades: { ...blueprint.preInstalled },
    fuelTypes: [{ good: blueprint.fuelType, perDistance: 1.0 }],
    // Comes with a half tank so the player can move it off the dock
    // without an immediate refuel run.
    currentFuel: { good: blueprint.fuelType, qty: Math.floor(blueprint.baseFuelCapacity / 2) },
    funds: 0,
    location: locationId,
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "manual",
    log: [],
    shipClass: blueprint.class,
    traits: blueprint.traits.length > 0 ? [...blueprint.traits] : undefined,
  };
  // Apply pre-installed upgrade effects to the live stats.
  recomputeShipStats(trader);
  return trader;
}

function uniqueShipId(blueprint: ShipBlueprint, world: World): TraderId {
  const baseId = `p_${blueprint.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  if (!world.traders[baseId]) return baseId;
  let i = 2;
  while (world.traders[`${baseId}_${i}`]) i += 1;
  return `${baseId}_${i}`;
}

// --- trait queries ------------------------------------------------------

// Helpers used by the crew/upgrade systems to ask "does this ship
// behave as if it has a captain?" etc. Centralised here so future
// trait additions only need to touch one site.
export function hasShipTrait(ship: Trader, trait: ShipTrait): boolean {
  return Array.isArray(ship.traits) && ship.traits.includes(trait);
}

export function isSelfPiloted(ship: Trader): boolean {
  return hasShipTrait(ship, "self-piloted");
}

export function hasBuiltInNavigator(ship: Trader): boolean {
  return hasShipTrait(ship, "ai-navigator");
}

void isUpgradeGood;                                  // imported for future inventory filters
