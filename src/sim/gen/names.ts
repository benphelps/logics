import { pick, type Rng } from "./rng";

const PREFIXES = [
  "New", "Old", "Far", "Near", "Upper", "Lower", "Outer", "Inner",
  "North", "South", "East", "West", "Greater", "Lesser", "High", "Deep",
];

const HUB_ROOTS = [
  "Haven", "Concord", "Meridian", "Apex", "Junction", "Crossroads",
  "Forum", "Plaza", "Atrium", "Centrum",
];

const MINING_ROOTS = [
  "Iron", "Copper", "Stone", "Slag", "Forge", "Cinder", "Ember",
  "Anvil", "Quarry", "Vein", "Lode", "Pit",
];

const AGRI_ROOTS = [
  "Verdant", "Greenfield", "Harvest", "Bloom", "Orchard", "Garden",
  "Meadow", "Spring", "Fertile", "Bountiful",
];

const FRONTIER_ROOTS = [
  "Saffron", "Drift", "Wildwood", "Rimward", "Tideward", "Outpost",
  "Lonewolf", "Beacon", "Lantern", "Pyre",
];

const RESEARCH_ROOTS = [
  "Praxis", "Gnosis", "Lyceum", "Atheneum", "Codex", "Archive",
  "Crucible", "Sigma", "Theta", "Omicron",
];

const HUB_SUFFIX = ["Station", "Port", "Hub", "Exchange", "Gateway"];
const MINING_SUFFIX = ["Belt", "Reach", "Hold", "Foundry", "Works"];
const AGRI_SUFFIX = ["Ring", "Habitat", "Bloom", "Canopy", "Vault"];
const FRONTIER_SUFFIX = ["Rim", "Edge", "Reach", "Outpost", "Drift"];
const RESEARCH_SUFFIX = ["Lab", "Institute", "Spire", "Array", "Compound"];

export type ArchetypeName = "trade-hub" | "mining-belt" | "agricultural-ring" | "frontier-outpost" | "research-station";

const ROOTS: Record<ArchetypeName, readonly string[]> = {
  "trade-hub":          HUB_ROOTS,
  "mining-belt":        MINING_ROOTS,
  "agricultural-ring":  AGRI_ROOTS,
  "frontier-outpost":   FRONTIER_ROOTS,
  "research-station":   RESEARCH_ROOTS,
};

const SUFFIXES: Record<ArchetypeName, readonly string[]> = {
  "trade-hub":          HUB_SUFFIX,
  "mining-belt":        MINING_SUFFIX,
  "agricultural-ring":  AGRI_SUFFIX,
  "frontier-outpost":   FRONTIER_SUFFIX,
  "research-station":   RESEARCH_SUFFIX,
};

export const STATION_NAME_ROOTS = ROOTS;
export const STATION_NAME_SUFFIXES = SUFFIXES;

export function generateName(rng: Rng, archetype: ArchetypeName, used: Set<string>): { name: string; id: string } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const prefix = rng() < 0.4 ? `${pick(rng, PREFIXES)} ` : "";
    const root = pick(rng, ROOTS[archetype]);
    const suffix = pick(rng, SUFFIXES[archetype]);
    const name = `${prefix}${root} ${suffix}`;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (!used.has(id)) {
      used.add(id);
      return { name, id };
    }
  }
  let i = 2;
  while (true) {
    const root = pick(rng, ROOTS[archetype]);
    const suffix = pick(rng, SUFFIXES[archetype]);
    const name = `${root} ${suffix} ${i}`;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (!used.has(id)) {
      used.add(id);
      return { name, id };
    }
    i++;
  }
}

const SHIP_PREFIXES = [
  "Pelican", "Mantis", "Kestrel", "Falcon", "Mule", "Otter", "Marlin", "Swallow",
  "Drover", "Camel", "Heron", "Stoat", "Stag", "Ram", "Wolf", "Hawk", "Hound",
  "Lynx", "Sable", "Eider", "Vulture", "Raven", "Magpie", "Sparrow", "Albatross",
  "Skylark", "Pinion", "Cygnet", "Tern", "Egret",
];

const SHIP_DESIGNATORS = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII",
  "Mk1", "Mk2", "Mk3", "Mk4",
  "Alpha", "Beta", "Gamma", "Delta", "Sigma",
];

export const SHIP_NAME_ROOTS = SHIP_PREFIXES;
export const SHIP_NAME_DESIGNATORS = SHIP_DESIGNATORS;

export function generateShipName(rng: Rng, used: Set<string>): { name: string; id: string } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const root = pick(rng, SHIP_PREFIXES);
    const designator = rng() < 0.5 ? ` ${pick(rng, SHIP_DESIGNATORS)}` : "";
    const name = `${root}${designator}`;
    const id = `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    if (!used.has(id)) {
      used.add(id);
      return { name, id };
    }
  }
  let i = 2;
  while (true) {
    const root = pick(rng, SHIP_PREFIXES);
    const name = `${root} ${i}`;
    const id = `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    if (!used.has(id)) {
      used.add(id);
      return { name, id };
    }
    i++;
  }
}
