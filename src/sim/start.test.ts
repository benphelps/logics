import { describe, expect, it } from "vitest";
import { DEFAULT_STARTING_WORLD, choosePlayerStart, createStartingWorld } from "./start";
import { generateWorld } from "./gen/world";
import { reachableNeighbors, routeCount } from "./geometry";

describe("playable starting world", () => {
  it("uses the expanded generated universe defaults", () => {
    const world = createStartingWorld();
    expect(Object.keys(world.locations).length).toBe(DEFAULT_STARTING_WORLD.locationCount);
    expect(Object.keys(world.traders).length).toBe(DEFAULT_STARTING_WORLD.traderCount + 1);
    expect(world.tick).toBe(DEFAULT_STARTING_WORLD.ageTicks);
    expect(routeCount(world)).toBeGreaterThan(DEFAULT_STARTING_WORLD.locationCount - 1);
    const ship = world.traders[world.player!.shipIds[0]];
    expect(reachableNeighbors(world, ship.location).length).toBeGreaterThan(0);
  });

  it("ages the economy before the player ship is inserted", () => {
    const world = createStartingWorld({ seed: 10, locationCount: 12, traderCount: 18, ageTicks: 30 });
    const ship = world.traders[world.player!.shipIds[0]];
    expect(ship).toBeDefined();
    expect(ship.state).toBe("idle");
    expect(ship.log).toEqual([]);
    expect(ship.maintenanceDebt).toBeUndefined();
    expect(world.locations[ship.location]).toBeDefined();
    expect(world.tick).toBe(30);
  });

  it("chooses a central trade hub when one exists", () => {
    const world = generateWorld({ seed: 20260427, locationCount: 24, traderCount: 0, player: null });
    const start = choosePlayerStart(world);
    expect(world.locations[start]).toBeDefined();
    expect(world.locations[start].traits.tags).toContain("trade-hub");
  });

  it("honors an explicit valid starting location", () => {
    const world = createStartingWorld({
      seed: 11,
      locationCount: 8,
      traderCount: 4,
      ageTicks: 0,
      startingLocation: "missing",
    });
    const fallback = world.traders[world.player!.shipIds[0]].location;
    const explicit = Object.keys(world.locations).find(id => id !== fallback)!;
    const withExplicit = createStartingWorld({
      seed: 11,
      locationCount: 8,
      traderCount: 4,
      ageTicks: 0,
      startingLocation: explicit,
    });
    expect(withExplicit.traders[withExplicit.player!.shipIds[0]].location).toBe(explicit);
  });
});
