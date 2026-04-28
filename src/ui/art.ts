import { upgradeDef } from "../sim/upgrades";
import type { GoodId, LocationDef, Trader, UpgradeSlot, World } from "../sim/types";

export type StationKind = "hub" | "mining" | "agri" | "frontier" | "research" | "station";
export type StationScale = "compact" | "standard" | "large";
export type StationSubtype =
  | "gateway"
  | "plaza"
  | "foundry"
  | "belt"
  | "bloom"
  | "habitat"
  | "beacon"
  | "rim"
  | "spire"
  | "lab";

export type ShipArtFamily = "freighter" | "hauler" | "courier" | "scout" | "tanker";

export const SHIP_ART: Record<ShipArtFamily | "default", string> = {
  default: "/art/ships/voyager-freighter.webp",
  freighter: "/art/ships/voyager-freighter.webp",
  hauler: "/art/ships/cargo-hauler.webp",
  courier: "/art/ships/courier.webp",
  scout: "/art/ships/scout.webp",
  tanker: "/art/ships/tanker.webp",
};

export const SHIP_FAMILY_TERMS: Record<ShipArtFamily, string[]> = {
  freighter: ["voyager", "pelican", "drover", "albatross", "leviathan"],
  hauler: ["mule", "camel", "stag", "ram", "heron", "eider"],
  courier: ["kestrel", "falcon", "swallow", "hawk", "sparrow", "skylark", "pinion", "tern", "egret", "cygnet"],
  scout: ["mantis", "otter", "stoat", "wolf", "hound", "lynx", "sable", "raven", "magpie", "vulture"],
  tanker: ["marlin"],
};

export const STATION_ART: Record<string, string> = {
  hub: "/art/stations/trade-hub.webp",
  "hub:gateway": "/art/stations/hub-gateway.webp",
  "hub:plaza": "/art/stations/hub-plaza.webp",
  "hub:compact": "/art/stations/hub-plaza.webp",
  "hub:large": "/art/stations/hub-gateway.webp",
  mining: "/art/stations/mining-belt.webp",
  "mining:foundry": "/art/stations/mining-foundry.webp",
  "mining:belt": "/art/stations/mining-belt-small.webp",
  "mining:compact": "/art/stations/mining-belt-small.webp",
  "mining:large": "/art/stations/mining-foundry.webp",
  agri: "/art/stations/agricultural-ring.webp",
  "agri:bloom": "/art/stations/agri-bloom.webp",
  "agri:habitat": "/art/stations/agri-habitat.webp",
  "agri:compact": "/art/stations/agri-habitat.webp",
  "agri:large": "/art/stations/agricultural-ring.webp",
  frontier: "/art/stations/frontier-outpost.webp",
  "frontier:beacon": "/art/stations/frontier-beacon.webp",
  "frontier:rim": "/art/stations/frontier-rim.webp",
  "frontier:compact": "/art/stations/frontier-rim.webp",
  "frontier:large": "/art/stations/frontier-beacon.webp",
  research: "/art/stations/research-station.webp",
  "research:spire": "/art/stations/research-spire.webp",
  "research:lab": "/art/stations/research-lab.webp",
  "research:compact": "/art/stations/research-lab.webp",
  "research:large": "/art/stations/research-spire.webp",
  station: "/art/stations/trade-hub.webp",
};

export const STATION_SUBTYPE_TERMS: Record<StationKind, Array<{ subtype: StationSubtype; terms: string[] }>> = {
  hub: [
    { subtype: "gateway", terms: ["meridian", "junction", "crossroads", "gateway", "exchange", "port"] },
    { subtype: "plaza", terms: ["haven", "concord", "apex", "forum", "plaza", "atrium", "centrum", "hub", "station"] },
  ],
  mining: [
    { subtype: "foundry", terms: ["forge", "cinder", "ember", "anvil", "slag", "foundry", "works", "hold"] },
    { subtype: "belt", terms: ["iron", "copper", "stone", "quarry", "vein", "lode", "pit", "belt", "reach"] },
  ],
  agri: [
    { subtype: "bloom", terms: ["verdant", "greenfield", "harvest", "bloom", "orchard", "garden", "meadow", "spring"] },
    { subtype: "habitat", terms: ["fertile", "bountiful", "ring", "habitat", "canopy", "vault"] },
  ],
  frontier: [
    { subtype: "beacon", terms: ["beacon", "lantern", "pyre", "saffron"] },
    { subtype: "rim", terms: ["drift", "wildwood", "rimward", "tideward", "outpost", "lonewolf", "rim", "edge", "reach"] },
  ],
  research: [
    { subtype: "spire", terms: ["gnosis", "lyceum", "atheneum", "codex", "archive", "spire", "array"] },
    { subtype: "lab", terms: ["praxis", "crucible", "sigma", "theta", "omicron", "lab", "institute", "compound"] },
  ],
  station: [],
};

export const GOOD_ART: Record<string, string> = {
  grain: "/art/goods/grain.webp",
  protein: "/art/goods/protein.webp",
  vatmeat: "/art/goods/vatmeat.webp",
  ore: "/art/goods/ore.webp",
  polymer: "/art/goods/polymer.webp",
  fiber: "/art/goods/fiber.webp",
  parts: "/art/goods/parts.webp",
  xenospice: "/art/goods/xenospice.webp",
  silk: "/art/goods/silk.webp",
  plasma: "/art/goods/plasma.webp",
  antimatter: "/art/goods/antimatter.webp",
  electronics: "/art/goods/electronics.webp",
  weapons: "/art/goods/weapons.webp",
  luxury_goods: "/art/goods/luxury_goods.webp",
  medkits: "/art/goods/medkits.webp",
  raw: "/art/goods/raw-materials.webp",
  intermediate: "/art/goods/intermediate-components.webp",
  luxury: "/art/goods/luxury-goods.webp",
  fuel: "/art/goods/fuel-cells.webp",
  advanced: "/art/goods/advanced-goods.webp",
  upgrade: "/art/goods/generic-goods.webp",
  generic: "/art/goods/generic-goods.webp",
};

export const UPGRADE_ART: Record<UpgradeSlot, string> = {
  cargo: "/art/upgrades/cargo-hold.webp",
  engine: "/art/upgrades/engine-kit.webp",
  fuel: "/art/upgrades/fuel-tank.webp",
  hull: "/art/upgrades/hull-plating.webp",
  weapon: "/art/upgrades/weapon-mount.webp",
};

export function shipArtUrl(ship: Trader): string {
  return SHIP_ART[shipArtFamily(ship)] ?? SHIP_ART.default;
}

export function shipArtFamily(ship: Trader): ShipArtFamily {
  const haystack = `${ship.name} ${ship.id}`.toLowerCase();
  for (const family of Object.keys(SHIP_FAMILY_TERMS) as ShipArtFamily[]) {
    if (SHIP_FAMILY_TERMS[family].some(term => haystack.includes(term))) return family;
  }

  if (ship.capacity >= 95) return "hauler";
  if (ship.speed >= 2) return "courier";
  if (ship.fuelCapacity >= 55) return "tanker";
  return "freighter";
}

export function stationArtUrl(loc: LocationDef): string {
  for (const key of stationArtCandidates(loc)) {
    const url = STATION_ART[key];
    if (url) return url;
  }
  return STATION_ART.station;
}

export function stationArtCandidates(loc: LocationDef): string[] {
  const kind = stationKind(loc);
  const subtype = stationSubtype(loc, kind);
  const scale = stationScale(loc, kind);
  const candidates: string[] = [];
  if (subtype) {
    candidates.push(`${kind}:${subtype}:${scale}`, `${kind}:${subtype}`);
  }
  candidates.push(`${kind}:${scale}`, kind, "station");
  return candidates;
}

export function stationKind(loc: LocationDef): StationKind {
  const tags = loc.traits.tags;
  if (tags.includes("trade-hub")) return "hub";
  if (tags.includes("mining") || tags.includes("industrial")) return "mining";
  if (tags.includes("agricultural")) return "agri";
  if (tags.includes("frontier") || tags.includes("rim")) return "frontier";
  if (tags.includes("research") || tags.includes("high-tech")) return "research";
  return "station";
}

export function stationKindLabel(kind: StationKind): string {
  switch (kind) {
    case "hub": return "Hub";
    case "mining": return "Industrial";
    case "agri": return "Agri";
    case "frontier": return "Frontier";
    case "research": return "Research";
    default: return "Station";
  }
}

export function stationSubtype(loc: LocationDef, kind = stationKind(loc)): StationSubtype | null {
  return stationSubtypeFromText(`${loc.name} ${loc.id}`, kind);
}

export function stationSubtypeFromText(text: string, kind: StationKind): StationSubtype | null {
  const haystack = text.toLowerCase();
  const entries = STATION_SUBTYPE_TERMS[kind] ?? [];
  return entries.find(entry => entry.terms.some(term => haystack.includes(term)))?.subtype ?? null;
}

export function stationSubtypeLabel(subtype: StationSubtype): string {
  switch (subtype) {
    case "gateway": return "Gateway";
    case "plaza": return "Civic";
    case "foundry": return "Foundry";
    case "belt": return "Belt";
    case "bloom": return "Bloom";
    case "habitat": return "Habitat";
    case "beacon": return "Beacon";
    case "rim": return "Rim";
    case "spire": return "Spire";
    case "lab": return "Lab";
  }
}

export function stationScale(loc: LocationDef, kind = stationKind(loc)): StationScale {
  const tech = loc.traits.techLevel;
  switch (kind) {
    case "hub":
      if (loc.population >= 1200) return "large";
      if (loc.population <= 900) return "compact";
      return "standard";
    case "mining":
      if (loc.population >= 850 || tech >= 8) return "large";
      if (loc.population <= 600) return "compact";
      return "standard";
    case "agri":
      if (loc.population >= 1600) return "large";
      if (loc.population <= 1200) return "compact";
      return "standard";
    case "frontier":
      if (loc.population >= 600 || tech >= 6) return "large";
      if (loc.population <= 400) return "compact";
      return "standard";
    case "research":
      if (tech >= 9) return "large";
      if (loc.population <= 300) return "compact";
      return "standard";
    default:
      if (loc.population >= 1200 || tech >= 8) return "large";
      if (loc.population <= 500) return "compact";
      return "standard";
  }
}

export function stationScaleLabel(scale: StationScale): string {
  switch (scale) {
    case "compact": return "Compact";
    case "standard": return "Standard";
    case "large": return "Large";
  }
}

export function goodArtUrl(world: World, good: GoodId): string {
  const exact = GOOD_ART[good];
  if (exact) return exact;

  const upg = upgradeDef(good);
  if (upg) return UPGRADE_ART[upg.slot] ?? GOOD_ART.upgrade;

  const category = world.goods[good]?.category;
  return (category && GOOD_ART[category]) || GOOD_ART.generic;
}
