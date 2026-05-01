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

// Shortest path through the lane network from `from` to `to`,
// inclusive of both endpoints. Returns null when the two stations
// aren't connected in the same component. Worlds with no lane network
// at all treat every station as one hop apart (matches routeExists).
export function findRoutePath(world: World, from: LocationId, to: LocationId): LocationId[] | null {
  if (from === to) return [from];
  if (!world.locations[from] || !world.locations[to]) return null;
  if (!hasRouteNetwork(world)) return [from, to];

  // Dijkstra over the lane graph. The graph is small (sub-100
  // stations), so a min-heap is overkill — a linear scan of the open
  // set is plenty fast.
  const dists: Record<LocationId, number> = { [from]: 0 };
  const prev: Record<LocationId, LocationId | null> = { [from]: null };
  const open = new Set<LocationId>([from]);
  const closed = new Set<LocationId>();

  while (open.size > 0) {
    let best: LocationId | null = null;
    let bestDist = Infinity;
    for (const id of open) {
      const d = dists[id];
      if (d != null && d < bestDist) { bestDist = d; best = id; }
    }
    if (best == null) break;
    open.delete(best);
    closed.add(best);
    if (best === to) break;

    const edges = (world.lanes[best] ?? {}) as Record<LocationId, number>;
    for (const next of Object.keys(edges) as LocationId[]) {
      if (closed.has(next) || !world.locations[next]) continue;
      const stepDist = distance(world, best, next);
      const candidate = bestDist + stepDist;
      if (dists[next] == null || candidate < dists[next]) {
        dists[next] = candidate;
        prev[next] = best;
        open.add(next);
      }
    }
  }

  if (!closed.has(to)) return null;
  const path: LocationId[] = [];
  let node: LocationId | null = to;
  while (node != null) {
    path.unshift(node);
    node = prev[node] ?? null;
  }
  return path;
}

export function pathDistance(world: World, path: readonly LocationId[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += distance(world, path[i], path[i + 1]);
  }
  return total;
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
