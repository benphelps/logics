import type { LaneMap, LocationDef, LocationId, Position, World } from "./types";

export function euclidean(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function laneModifier(lanes: LaneMap, a: LocationId, b: LocationId): number {
  return lanes[a]?.[b] ?? lanes[b]?.[a] ?? 1.0;
}

export function hasRouteNetwork(world: World): boolean {
  return Object.values(world.lanes).some(edges => Object.keys(edges).length > 0);
}

export function routeExists(world: World, a: LocationId, b: LocationId): boolean {
  if (a === b) return true;
  if (!world.locations[a] || !world.locations[b]) return false;
  if (!hasRouteNetwork(world)) return true;
  return world.lanes[a]?.[b] != null || world.lanes[b]?.[a] != null;
}

export function distance(world: World, a: LocationId, b: LocationId): number {
  if (a === b) return 0;
  const locA = world.locations[a];
  const locB = world.locations[b];
  return euclidean(locA.position, locB.position) * laneModifier(world.lanes, a, b);
}

export function routeDistance(world: World, a: LocationId, b: LocationId): number | null {
  return routeExists(world, a, b) ? distance(world, a, b) : null;
}

export function reachableNeighbors(world: World, from: LocationId): { to: LocationId; dist: number }[] {
  const result: { to: LocationId; dist: number }[] = [];
  if (!hasRouteNetwork(world)) {
    for (const id of Object.keys(world.locations) as LocationId[]) {
      if (id === from) continue;
      result.push({ to: id, dist: distance(world, from, id) });
    }
    return result.sort((a, b) => a.dist - b.dist);
  }

  const ids = new Set<LocationId>();
  for (const id of Object.keys(world.lanes[from] ?? {}) as LocationId[]) ids.add(id);
  for (const [id, edges] of Object.entries(world.lanes) as [LocationId, Record<LocationId, number>][]) {
    if (edges[from] != null) ids.add(id);
  }
  ids.delete(from);

  for (const id of ids) {
    if (!world.locations[id]) continue;
    result.push({ to: id, dist: distance(world, from, id) });
  }
  return result.sort((a, b) => a.dist - b.dist);
}

export function nearestDistance(world: World, from: LocationId): number {
  return reachableNeighbors(world, from)[0]?.dist ?? 0;
}

export function routeSegments(world: World): { a: LocationId; b: LocationId; dist: number; modifier: number }[] {
  if (!hasRouteNetwork(world)) return [];
  const seen = new Set<string>();
  const out: { a: LocationId; b: LocationId; dist: number; modifier: number }[] = [];
  for (const [a, edges] of Object.entries(world.lanes) as [LocationId, Record<LocationId, number>][]) {
    if (!world.locations[a]) continue;
    for (const [b, modifier] of Object.entries(edges) as [LocationId, number][]) {
      if (!world.locations[b] || a === b) continue;
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, dist: distance(world, a, b), modifier });
    }
  }
  return out.sort((a, b) => a.dist - b.dist || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
}

export function routeCount(world: World): number {
  return routeSegments(world).length;
}

export function locationsOf(locations: Record<LocationId, LocationDef>): LocationDef[] {
  return Object.values(locations);
}
