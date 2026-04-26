import { describe, it, expect } from "vitest";
import { distance, euclidean, laneModifier, nearestDistance, reachableNeighbors } from "./geometry";
import { createWorld } from "./world";
import type { LaneMap, LocationDef } from "./types";

const tinyLocations: Record<string, LocationDef> = {
  a: { id: "a", name: "A", position: { x: 0, y: 0 }, population: 1, traits: { techLevel: 1, tags: [] }, primaryExports: [], primaryImports: [], produces: [], consumes: [], targetStock: {} },
  b: { id: "b", name: "B", position: { x: 3, y: 4 }, population: 1, traits: { techLevel: 1, tags: [] }, primaryExports: [], primaryImports: [], produces: [], consumes: [], targetStock: {} },
  c: { id: "c", name: "C", position: { x: 0, y: 10 }, population: 1, traits: { techLevel: 1, tags: [] }, primaryExports: [], primaryImports: [], produces: [], consumes: [], targetStock: {} },
};

describe("euclidean", () => {
  it("returns 0 for identical positions", () => {
    expect(euclidean({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });

  it("computes pythagorean distance", () => {
    expect(euclidean({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 5);
  });

  it("is symmetric", () => {
    const a = { x: 2.7, y: -1.3 };
    const b = { x: -4.1, y: 6.2 };
    expect(euclidean(a, b)).toBeCloseTo(euclidean(b, a), 5);
  });
});

describe("laneModifier", () => {
  it("returns 1.0 when no lane is defined", () => {
    expect(laneModifier({}, "a", "b")).toBe(1.0);
  });

  it("returns the explicit modifier when defined a→b", () => {
    const lanes: LaneMap = { a: { b: 0.5 } };
    expect(laneModifier(lanes, "a", "b")).toBe(0.5);
  });

  it("falls back to the reverse direction when only b→a is defined", () => {
    const lanes: LaneMap = { b: { a: 1.5 } };
    expect(laneModifier(lanes, "a", "b")).toBe(1.5);
  });

  it("prefers the forward direction when both are defined", () => {
    const lanes: LaneMap = { a: { b: 0.5 }, b: { a: 1.5 } };
    expect(laneModifier(lanes, "a", "b")).toBe(0.5);
  });
});

describe("distance (world helper)", () => {
  it("returns 0 for self", () => {
    const w = createWorld({ locations: tinyLocations, lanes: {}, traders: {} });
    expect(distance(w, "a", "a")).toBe(0);
  });

  it("derives euclidean from positions", () => {
    const w = createWorld({ locations: tinyLocations, lanes: {}, traders: {} });
    expect(distance(w, "a", "b")).toBeCloseTo(5, 5);
    expect(distance(w, "a", "c")).toBeCloseTo(10, 5);
  });

  it("is symmetric without lanes", () => {
    const w = createWorld({ locations: tinyLocations, lanes: {}, traders: {} });
    expect(distance(w, "a", "b")).toBeCloseTo(distance(w, "b", "a"), 5);
  });

  it("applies lane modifier as multiplier", () => {
    const w = createWorld({ locations: tinyLocations, lanes: { a: { b: 0.4 } }, traders: {} });
    expect(distance(w, "a", "b")).toBeCloseTo(5 * 0.4, 5);
  });

  it("can model asymmetric routes via direction-specific lanes", () => {
    const w = createWorld({
      locations: tinyLocations,
      lanes: { a: { b: 0.5 }, b: { a: 2.0 } },
      traders: {},
    });
    expect(distance(w, "a", "b")).toBeCloseTo(2.5, 5);
    expect(distance(w, "b", "a")).toBeCloseTo(10, 5);
  });
});

describe("nearestDistance", () => {
  it("returns distance to the closest other location", () => {
    const w = createWorld({ locations: tinyLocations, lanes: {}, traders: {} });
    expect(nearestDistance(w, "a")).toBeCloseTo(5, 5);
    expect(nearestDistance(w, "c")).toBeCloseTo(Math.min(10, Math.sqrt(9 + 36)), 5);
  });

  it("returns 0 when there are no other locations", () => {
    const w = createWorld({
      locations: { only: { id: "only", name: "Only", position: { x: 0, y: 0 }, population: 1, traits: { techLevel: 1, tags: [] }, primaryExports: [], primaryImports: [], produces: [], consumes: [], targetStock: {} } },
      lanes: {},
      traders: {},
    });
    expect(nearestDistance(w, "only")).toBe(0);
  });
});

describe("reachableNeighbors", () => {
  it("lists every other location with derived distance", () => {
    const w = createWorld({ locations: tinyLocations, lanes: {}, traders: {} });
    const ns = reachableNeighbors(w, "a");
    expect(ns.map(n => n.to).sort()).toEqual(["b", "c"]);
    const map = Object.fromEntries(ns.map(n => [n.to, n.dist]));
    expect(map.b).toBeCloseTo(5, 5);
    expect(map.c).toBeCloseTo(10, 5);
  });
});

describe("starter universe geometry", () => {
  it("haven sits at origin and ironhold is on the x-axis", () => {
    const w = createWorld({ traders: {} });
    expect(w.locations.haven.position).toEqual({ x: 0, y: 0 });
    expect(w.locations.ironhold.position.y).toBe(0);
  });

  it("saffron is the farthest port from every other location (rim character)", () => {
    const w = createWorld({ traders: {} });
    const ports = ["haven", "ironhold", "verdant"] as const;
    for (const a of ports) {
      const dToSaffron = distance(w, a, "saffron");
      for (const b of ports) {
        if (b === a) continue;
        const dAB = distance(w, a, b);
        expect(dToSaffron).toBeGreaterThan(dAB);
      }
    }
  });
});
