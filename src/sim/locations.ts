import type { GoodId, LocationDef, World } from "./types";

export function netProductionRate(loc: LocationDef, goodId: GoodId): number {
  const produced = loc.produces.find(p => p.good === goodId)?.ratePerTick ?? 0;
  const consumed = loc.consumes.find(c => c.good === goodId)?.ratePerTick ?? 0;
  return produced - consumed;
}

export function isNetExporter(loc: LocationDef, goodId: GoodId): boolean {
  return netProductionRate(loc, goodId) > 0;
}

export function isNetImporter(loc: LocationDef, goodId: GoodId): boolean {
  return netProductionRate(loc, goodId) < 0;
}

export function locationsExporting(world: World, goodId: GoodId): LocationDef[] {
  return Object.values(world.locations).filter(loc => isNetExporter(loc, goodId));
}

export function locationsImporting(world: World, goodId: GoodId): LocationDef[] {
  return Object.values(world.locations).filter(loc => isNetImporter(loc, goodId));
}

export function locationsByTag(world: World, tag: string): LocationDef[] {
  return Object.values(world.locations).filter(loc => loc.traits.tags.includes(tag));
}

export function locationsByFaction(world: World, faction: string): LocationDef[] {
  return Object.values(world.locations).filter(loc => loc.traits.faction === faction);
}

export function locationsAtTechLevel(world: World, minLevel: number): LocationDef[] {
  return Object.values(world.locations).filter(loc => loc.traits.techLevel >= minLevel);
}
