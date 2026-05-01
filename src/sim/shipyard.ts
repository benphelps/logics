import { recomputeShipStats } from "./crew";
import { mulberry32 } from "./gen/rng";
import { makeStartingShip } from "./data/player";
import type { GoodId, LocationId, Trader, UpgradeSlot, World } from "./types";
import { SHIP_UPGRADES, type ShipUpgradeDef } from "./upgrades";

export type ShipClass = "freighter" | "scout" | "gunship";
export interface ShipOffer { id: string; location: LocationId; name: string; class: ShipClass; price: number; traits: string[]; upgrades: GoodId[]; preview: Trader; }

const CLASS_TRAITS: Record<ShipClass, string[]> = {
  freighter: ["Bulk Rails", "Deep Hold", "Civilian Support AI"],
  scout: ["Long Sensor Mast", "Fast Ignition", "Spares Locker"],
  gunship: ["Combat Core", "Reinforced Bulkhead", "Targeting Relay"],
};

function isShipyard(world: World, location: LocationId): boolean {
  const tags = world.locations[location]?.traits.tags ?? [];
  return tags.includes("shipyard") || tags.includes("industrial") || tags.includes("trade-hub");
}

export function listShipOffers(world: World, location: LocationId): ShipOffer[] {
  if (!isShipyard(world, location)) return [];
  const rng = mulberry32(world.tick + location.length * 1_337);
  const classes: ShipClass[] = ["freighter", "scout", "gunship"];
  const offers: ShipOffer[] = [];
  for (let i = 0; i < 4; i++) {
    const klass = classes[Math.floor(rng() * classes.length)]!;
    const baseFunds = 0;
    const ship = makeStartingShip(`${klass.toUpperCase()}-${100 + Math.floor(rng() * 900)}`, location, baseFunds);
    ship.id = `yard_preview_${location}_${i}`;
    ship.baseCapacity = 70 + Math.floor(rng() * 110) + (klass === "freighter" ? 70 : 0);
    ship.baseFuelCapacity = 55 + Math.floor(rng() * 70) + (klass === "scout" ? 30 : 0);
    ship.baseSpeed = Number((0.8 + rng() * 0.8 + (klass === "scout" ? 0.4 : 0)).toFixed(2));
    ship.baseHull = 3 + Math.floor(rng() * 4) + (klass === "gunship" ? 2 : 0);
    ship.baseWeaponPower = (klass === "gunship" ? 2 : 0) + Math.floor(rng() * 2);
    ship.upgrades = {};
    const pool = Object.values(SHIP_UPGRADES).filter((u) => allowedForClass(klass, u));
    for (let s = 0; s < 2 + Math.floor(rng() * 3); s++) {
      const pick = pool[Math.floor(rng() * pool.length)];
      if (pick) ship.upgrades[pick.slot as UpgradeSlot] = pick.id;
    }
    recomputeShipStats(ship);
    const price = Math.round((1_800_000 + rng() * 4_500_000) * (1 + (Object.keys(ship.upgrades).length * 0.09)));
    offers.push({
      id: `${location}-${world.tick >> 5}-${i}`,
      location,
      name: ship.name,
      class: klass,
      price,
      traits: [CLASS_TRAITS[klass][Math.floor(rng() * 3)]!, ...(klass === "scout" ? ["No-crew autopilot core"] : [])],
      upgrades: Object.values(ship.upgrades),
      preview: ship,
    });
  }
  return offers;
}

function allowedForClass(klass: ShipClass, u: ShipUpgradeDef): boolean {
  if (klass === "freighter") return u.slot !== "weapon" || u.tier <= 2;
  if (klass === "scout") return u.slot !== "hull" || u.tier <= 2;
  return true;
}

export function buyShipFromShipyard(world: World, buyerShipId: string, offerId: string): { ok: boolean; reason?: string; shipId?: string } {
  const buyer = world.traders[buyerShipId];
  if (!world.player || !buyer) return { ok: false, reason: "No player ship." };
  const offers = listShipOffers(world, buyer.location);
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) return { ok: false, reason: "Offer not found." };
  if (buyer.funds < offer.price) return { ok: false, reason: "Insufficient ship funds." };
  buyer.funds -= offer.price;
  const ship = structuredClone(offer.preview);
  ship.id = `p_ship_${Object.keys(world.traders).length + 1}`;
  ship.name = offer.name;
  ship.location = buyer.location;
  ship.state = "idle";
  ship.funds = 75_000;
  world.traders[ship.id] = ship;
  world.player.shipIds.push(ship.id);
  return { ok: true, shipId: ship.id };
}
