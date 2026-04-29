import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOODS } from "../sim/data/goods";
import { createStartingWorld } from "../sim/start";
import type { ArchetypeName } from "../sim/gen/names";
import { SHIP_NAME_ROOTS, STATION_NAME_ROOTS, STATION_NAME_SUFFIXES } from "../sim/gen/names";
import type { LocationDef, Trader } from "../sim/types";
import { UPGRADE_SLOTS, isUpgradeGood } from "../sim/upgrades";
import {
  GOOD_ART,
  HEADER_ART,
  SHIP_TAB_ART,
  SHIP_ART,
  SHIP_FAMILY_TERMS,
  STATION_ART,
  UPGRADE_ART,
  type StationKind,
  type StationScale,
  goodArtUrl,
  shipArtFamily,
  shipArtUrl,
  stationArtCandidates,
  stationArtUrl,
  stationKind,
  stationSubtypeFromText,
} from "../ui/art";

const PUBLIC_DIR = join(process.cwd(), "public");

const STATION_ARCHETYPES: Array<{ archetype: ArchetypeName; kind: StationKind; tags: string[] }> = [
  { archetype: "trade-hub", kind: "hub", tags: ["trade-hub", "core", "civilian"] },
  { archetype: "mining-belt", kind: "mining", tags: ["industrial", "core", "mining"] },
  { archetype: "agricultural-ring", kind: "agri", tags: ["agricultural", "ring-habitat", "core"] },
  { archetype: "frontier-outpost", kind: "frontier", tags: ["frontier", "rim", "luxury"] },
  { archetype: "research-station", kind: "research", tags: ["research", "high-tech"] },
];

const SCALE_FIXTURES: Record<StationKind, Record<StationScale, { population: number; techLevel: number }>> = {
  hub: {
    compact: { population: 850, techLevel: 5 },
    standard: { population: 1000, techLevel: 6 },
    large: { population: 1300, techLevel: 7 },
  },
  mining: {
    compact: { population: 550, techLevel: 6 },
    standard: { population: 700, techLevel: 7 },
    large: { population: 900, techLevel: 8 },
  },
  agri: {
    compact: { population: 1100, techLevel: 3 },
    standard: { population: 1400, techLevel: 4 },
    large: { population: 1700, techLevel: 5 },
  },
  frontier: {
    compact: { population: 350, techLevel: 4 },
    standard: { population: 500, techLevel: 5 },
    large: { population: 650, techLevel: 6 },
  },
  research: {
    compact: { population: 250, techLevel: 7 },
    standard: { population: 400, techLevel: 8 },
    large: { population: 450, techLevel: 9 },
  },
  station: {
    compact: { population: 400, techLevel: 5 },
    standard: { population: 700, techLevel: 6 },
    large: { population: 1300, techLevel: 8 },
  },
};

function artExists(url: string): boolean {
  return existsSync(join(PUBLIC_DIR, url.replace(/^\//, "")));
}

function status(url: string): string {
  return artExists(url) ? "covered" : "missing";
}

function fakeStation(kind: StationKind, name: string, scale: StationScale = "standard"): LocationDef {
  const fixture = SCALE_FIXTURES[kind][scale];
  const archetype = STATION_ARCHETYPES.find(entry => entry.kind === kind);
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    name,
    position: { x: 0, y: 0 },
    population: fixture.population,
    traits: {
      techLevel: fixture.techLevel,
      tags: archetype?.tags ?? [],
      faction: "Coverage",
    },
    primaryExports: [],
    primaryImports: [],
    produces: [],
    consumes: [],
    targetStock: {},
  };
}

function fakeShip(root: string): Trader {
  return {
    id: `t_${root.toLowerCase()}`,
    name: root,
    capacity: 60,
    speed: 1,
    fuelCapacity: 30,
    fuelTypes: [{ good: "plasma", perDistance: 1 }],
    currentFuel: { good: "plasma", qty: 30 },
    funds: 0,
    location: "",
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "npc",
    log: [],
  };
}

function firstResolvedKey(candidates: string[], table: Record<string, string>): string | null {
  return candidates.find(key => table[key] != null) ?? null;
}

function lineTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, sep, ...rows.map(row => `| ${row.join(" | ")} |`)].join("\n");
}

function summarize(label: string, total: number, covered: number): string {
  const pct = total === 0 ? 100 : Math.round((covered / total) * 100);
  return `| ${label} | ${covered}/${total} | ${pct}% |`;
}

function main(): void {
  const assetUrls = new Set<string>([
    ...Object.values(SHIP_ART),
    ...Object.values(STATION_ART),
    ...Object.values(GOOD_ART),
    ...Object.values(UPGRADE_ART),
    ...Object.values(HEADER_ART),
    ...Object.values(SHIP_TAB_ART),
  ]);
  const missingAssets = [...assetUrls].filter(url => !artExists(url)).sort();

  const shipRows = SHIP_NAME_ROOTS.map(root => {
    const ship = fakeShip(root);
    const family = shipArtFamily(ship);
    const url = shipArtUrl(ship);
    const directRoot = SHIP_FAMILY_TERMS[family].some(term => root.toLowerCase().includes(term));
    return [root, family, directRoot ? "name-root" : "stat fallback", url, status(url)];
  });

  const stationTermRows = STATION_ARCHETYPES.map(({ archetype, kind }) => {
    const terms = [...STATION_NAME_ROOTS[archetype], ...STATION_NAME_SUFFIXES[archetype]];
    const unmatched = terms.filter(term => stationSubtypeFromText(term, kind) == null);
    const subtypes = new Set(terms.map(term => stationSubtypeFromText(term, kind)).filter(Boolean));
    const variantKeys = [...subtypes].map(subtype => `${kind}:${subtype}`);
    const covered = variantKeys.filter(key => STATION_ART[key] && artExists(STATION_ART[key])).length;
    return [
      archetype,
      kind,
      `${terms.length - unmatched.length}/${terms.length}`,
      variantKeys.join(", ") || "-",
      `${covered}/${variantKeys.length}`,
      unmatched.join(", ") || "-",
    ];
  });

  const stationScaleKinds = [...STATION_ARCHETYPES.map(entry => entry.kind), "station"] as StationKind[];
  const stationScaleRows = stationScaleKinds.flatMap(kind => {
    return (["compact", "standard", "large"] as StationScale[]).map(scale => {
      const loc = fakeStation(kind, `${kind} ${scale}`, scale);
      const candidates = stationArtCandidates(loc);
      const key = firstResolvedKey(candidates, STATION_ART) ?? "-";
      const url = stationArtUrl(loc);
      return [kind, scale, key, url, status(url)];
    });
  });

  const world = createStartingWorld();
  const worldStationRows = Object.values(world.locations).map(loc => {
    const candidates = stationArtCandidates(loc);
    const key = firstResolvedKey(candidates, STATION_ART) ?? "-";
    const url = stationArtUrl(loc);
    return [loc.name, stationKind(loc), key, url, status(url)];
  });

  const goodRows = Object.values(GOODS)
    .filter(good => !isUpgradeGood(good.id))
    .map(good => {
      const url = goodArtUrl(world, good.id);
      const mode = GOOD_ART[good.id] ? "exact" : GOOD_ART[good.category] ? "category" : "generic";
      return [good.name, good.id, good.category, mode, url, status(url)];
    });

  const upgradeRows = UPGRADE_SLOTS.map(({ slot }) => {
    const url = UPGRADE_ART[slot];
    return [slot, url, status(url)];
  });

  const headerRows = (Object.keys(HEADER_ART) as Array<keyof typeof HEADER_ART>).map(key => {
    const url = HEADER_ART[key];
    return [key, url, status(url)];
  });

  const shipTabRows = (Object.keys(SHIP_TAB_ART) as Array<keyof typeof SHIP_TAB_ART>).map(key => {
    const url = SHIP_TAB_ART[key];
    return [key, url, status(url)];
  });

  const sections = [
    "# Art Coverage",
    "",
    "Generated by `npm run art:coverage -- --write`. See `docs/ART_WORKFLOW.md` for the asset workflow.",
    "",
    "## Summary",
    "",
    lineTable(["Area", "Covered", "Coverage"], [
      summarize("Referenced asset files", assetUrls.size, assetUrls.size - missingAssets.length).slice(2, -2).split(" | "),
      summarize("Ship name roots", shipRows.length, shipRows.filter(row => row[4] === "covered").length).slice(2, -2).split(" | "),
      summarize("Station default universe", worldStationRows.length, worldStationRows.filter(row => row[4] === "covered").length).slice(2, -2).split(" | "),
      summarize("Trade goods", goodRows.length, goodRows.filter(row => row[5] === "covered").length).slice(2, -2).split(" | "),
      summarize("Trade goods exact art", goodRows.length, goodRows.filter(row => row[3] === "exact").length).slice(2, -2).split(" | "),
      summarize("Upgrade slots", upgradeRows.length, upgradeRows.filter(row => row[2] === "covered").length).slice(2, -2).split(" | "),
      summarize("Header backdrops", headerRows.length, headerRows.filter(row => row[2] === "covered").length).slice(2, -2).split(" | "),
      summarize("Ship tab backdrops", shipTabRows.length, shipTabRows.filter(row => row[2] === "covered").length).slice(2, -2).split(" | "),
    ]),
    "",
    "## Missing Asset Files",
    "",
    missingAssets.length > 0 ? missingAssets.map(url => `- ${url}`).join("\n") : "None.",
    "",
    "## Ship Name Roots",
    "",
    lineTable(["Root", "Family", "Match", "Art", "Status"], shipRows),
    "",
    "## Station Name Terms",
    "",
    lineTable(["Archetype", "Kind", "Matched Terms", "Variant Keys", "Variant Assets", "Unmatched"], stationTermRows),
    "",
    "## Station Scale Resolution",
    "",
    lineTable(["Kind", "Scale", "Resolved Key", "Art", "Status"], stationScaleRows),
    "",
    "## Default Universe Stations",
    "",
    lineTable(["Station", "Kind", "Resolved Key", "Art", "Status"], worldStationRows),
    "",
    "## Trade Goods",
    "",
    lineTable(["Good", "ID", "Category", "Mode", "Art", "Status"], goodRows),
    "",
    "## Upgrade Slots",
    "",
    lineTable(["Slot", "Art", "Status"], upgradeRows),
    "",
    "## Header Backdrops",
    "",
    lineTable(["Key", "Art", "Status"], headerRows),
    "",
    "## Ship Tab Backdrops",
    "",
    lineTable(["Key", "Art", "Status"], shipTabRows),
    "",
  ];

  const output = `${sections.join("\n").trimEnd()}\n`;
  if (process.argv.includes("--write")) {
    mkdirSync(join(process.cwd(), "docs"), { recursive: true });
    writeFileSync(join(process.cwd(), "docs", "ART_COVERAGE.md"), output);
  }
  process.stdout.write(output);
}

main();
