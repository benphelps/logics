import { recomputeShipStats } from "./crew";
import { pushNote } from "./log";
import type { ShipClass, ShipOffer, Trader, World } from "./types";

const SHIP_CLASSES: Record<ShipClass, { capacity: [number, number]; speed: [number, number]; fuel: [number, number]; hull: [number, number]; weapon: [number, number]; price: [number, number]; }> = {
  courier: { capacity: [45, 90], speed: [1.2, 2.2], fuel: [60, 120], hull: [2, 5], weapon: [0, 2], price: [1_200_000, 2_600_000] },
  freighter: { capacity: [120, 300], speed: [0.7, 1.3], fuel: [120, 260], hull: [4, 8], weapon: [1, 4], price: [2_200_000, 5_800_000] },
  gunship: { capacity: [60, 140], speed: [1.0, 1.8], fuel: [80, 170], hull: [6, 10], weapon: [4, 9], price: [2_600_000, 6_200_000] },
  explorer: { capacity: [70, 150], speed: [1.1, 1.9], fuel: [160, 320], hull: [3, 7], weapon: [1, 3], price: [1_800_000, 4_200_000] },
};
const SHIP_NAMES = ["Astra", "Kestrel", "Atlas", "Vanguard", "Nomad", "Zenith", "Drift", "Relic", "Wayfarer", "Arc"];
const SHIP_TRAITS = ["hardened frame", "ai copilot", "extended hardpoints", "low-drag hull", "modular holds", "combat telemetry"];
const CLASS_UPGRADE_POOL: Record<ShipClass, string[]> = {
  courier: ["upg_engine_2", "upg_fuel_bio_3", "upg_systems_nav_1", "upg_systems_exchange_2"],
  freighter: ["upg_cargo_2", "upg_cargo_3", "upg_fuel_aux_2", "upg_systems_haggler_2"],
  gunship: ["upg_hull_3", "upg_weapon_2", "upg_weapon_emp_3", "upg_systems_pressure_3"],
  explorer: ["upg_engine_singularity_3", "upg_fuel_2", "upg_systems_oracle_3", "upg_hull_stealth_2"],
};

function rand(seed: number): () => number {
  let s = seed | 0;
  return () => ((s = Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296;
}

function genOffer(world: World, location: string, slot: number): ShipOffer {
  const id = `ship_${world.nextShipOfferId ?? 1}`;
  world.nextShipOfferId = (world.nextShipOfferId ?? 1) + 1;
  const r = rand(world.tick * 131 + slot * 17 + location.length * 997);
  const classes = Object.keys(SHIP_CLASSES) as ShipClass[];
  const shipClass = classes[Math.floor(r() * classes.length)];
  const roll = SHIP_CLASSES[shipClass];
  const lerp = (a: number, b: number) => a + (b - a) * r();
  const upgrades = [...CLASS_UPGRADE_POOL[shipClass]].sort(() => r() - 0.5).slice(0, 2 + Math.floor(r() * 2));
  const traits = [...SHIP_TRAITS].sort(() => r() - 0.5).slice(0, 2);
  const crewless = traits.includes("ai copilot");
  return {
    id,
    location,
    name: `${SHIP_NAMES[Math.floor(r() * SHIP_NAMES.length)]}-${100 + Math.floor(r() * 900)}`,
    shipClass,
    price: Math.round(lerp(roll.price[0], roll.price[1])),
    traits,
    upgrades,
    baseCapacity: Math.round(lerp(roll.capacity[0], roll.capacity[1])) + (traits.includes("modular holds") ? 20 : 0),
    baseSpeed: Math.round(lerp(roll.speed[0], roll.speed[1]) * 100) / 100,
    baseFuelCapacity: Math.round(lerp(roll.fuel[0], roll.fuel[1])),
    baseHull: Math.round(lerp(roll.hull[0], roll.hull[1])),
    baseWeaponPower: Math.round(lerp(roll.weapon[0], roll.weapon[1])),
    crewless,
  };
}

export function refreshShipyardOffers(world: World): void {
  if (!world.shipOffers) world.shipOffers = {};
  for (const loc of Object.values(world.locations)) {
    if (!loc.traits.tags.includes("shipyard")) continue;
    const existing = Object.values(world.shipOffers).filter(s => s.location === loc.id);
    for (let i = existing.length; i < 4; i++) {
      const offer = genOffer(world, loc.id, i);
      world.shipOffers[offer.id] = offer;
    }
  }
}

export function listShipyardOffers(world: World, location: string): ShipOffer[] {
  refreshShipyardOffers(world);
  return Object.values(world.shipOffers ?? {}).filter(s => s.location === location).sort((a,b) => a.price - b.price);
}

export function buyShip(world: World, buyerShipId: string, offerId: string): { ok: boolean; reason?: string; shipId?: string } {
  if (!world.player) return { ok: false, reason: "No player." };
  const buyer = world.traders[buyerShipId];
  if (!buyer || !world.player.shipIds.includes(buyerShipId)) return { ok: false, reason: "Invalid buyer ship." };
  if (buyer.state !== "idle") return { ok: false, reason: "Buyer ship must be docked." };
  const offer = world.shipOffers?.[offerId];
  if (!offer) return { ok: false, reason: "Ship not available." };
  if (offer.location !== buyer.location) return { ok: false, reason: "Must be at the same shipyard." };
  if (buyer.funds < offer.price) return { ok: false, reason: "Insufficient ship funds." };
  buyer.funds -= offer.price;
  const shipId = `p_ship_${world.nextShipOfferId}`;
  const ship: Trader = {
    id: shipId, name: offer.name, capacity: offer.baseCapacity, speed: offer.baseSpeed, fuelCapacity: offer.baseFuelCapacity,
    baseCapacity: offer.baseCapacity, baseSpeed: offer.baseSpeed, baseFuelCapacity: offer.baseFuelCapacity,
    baseHull: offer.baseHull, baseWeaponPower: offer.baseWeaponPower, hull: offer.baseHull, weaponPower: offer.baseWeaponPower,
    upgrades: {}, fuelTypes: [{ good: "plasma", perDistance: 1.0 }], currentFuel: { good: "plasma", qty: offer.baseFuelCapacity },
    funds: 0, location: offer.location, state: "idle", cargo: [], destination: null, ticksRemaining: 0, pilot: "manual", log: [],
  };
  if (offer.crewless) ship.crew = {};
  recomputeShipStats(ship);
  world.traders[ship.id] = ship;
  world.player.shipIds.push(ship.id);
  delete world.shipOffers?.[offerId];
  pushNote(world, buyer, `Purchased ship ${ship.name} for Ç${offer.price.toLocaleString()}.`, "info");
  return { ok: true, shipId: ship.id };
}
