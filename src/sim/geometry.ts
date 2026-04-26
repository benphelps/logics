import type { LaneMap, LocationDef, LocationId, Position, World } from "./types";

export function euclidean(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function laneModifier(lanes: LaneMap, a: LocationId, b: LocationId): number {
  return lanes[a]?.[b] ?? lanes[b]?.[a] ?? 1.0;
}

export function distance(world: World, a: LocationId, b: LocationId): number {
  if (a === b) return 0;
  const locA = world.locations[a];
  const locB = world.locations[b];
  return euclidean(locA.position, locB.position) * laneModifier(world.lanes, a, b);
}

export function reachableNeighbors(world: World, from: LocationId): { to: LocationId; dist: number }[] {
  const result: { to: LocationId; dist: number }[] = [];
  for (const id of Object.keys(world.locations) as LocationId[]) {
    if (id === from) continue;
    result.push({ to: id, dist: distance(world, from, id) });
  }
  return result;
}

export function nearestDistance(world: World, from: LocationId): number {
  let min = Infinity;
  for (const id of Object.keys(world.locations) as LocationId[]) {
    if (id === from) continue;
    const d = distance(world, from, id);
    if (d < min) min = d;
  }
  return min === Infinity ? 0 : min;
}

export function locationsOf(locations: Record<LocationId, LocationDef>): LocationDef[] {
  return Object.values(locations);
}
