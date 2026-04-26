import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import type { Trader, World } from "./types";

function singleTraderWorld(overrides: Partial<Trader>): World {
  const t: Trader = {
    id: "t",
    name: "Test",
    capacity: 50,
    speed: 1,
    fuelCapacity: 20,
    fuelTypes: [{ good: "plasma", perDistance: 1 }],
    currentFuel: { good: "plasma", qty: 20 },
    funds: 5000,
    location: "haven",
    state: "idle",
    cargo: null,
    destination: null,
    ticksRemaining: 0,
    ...overrides,
  };
  return createWorld({ traders: { t } });
}

describe("fuel — single fuel type", () => {
  it("trader consumes fuel proportional to distance on departure", () => {
    const w = singleTraderWorld({});
    const startFuel = w.traders.t.currentFuel!.qty;
    for (let i = 0; i < 30 && w.traders.t.state !== "transit"; i++) tickWorld(w);
    expect(w.traders.t.state).toBe("transit");
    const distance = w.distances.haven[w.traders.t.destination!];
    const burned = startFuel - w.traders.t.currentFuel!.qty;
    expect(burned).toBeCloseTo(distance * 1, 5);
  });

  it("trader cannot depart for a destination it lacks fuel for", () => {
    const w = singleTraderWorld({
      fuelCapacity: 4,
      currentFuel: { good: "plasma", qty: 4 },
    });
    tickN(w, 5);
    if (w.traders.t.state === "transit") {
      const dist = w.distances.haven[w.traders.t.destination!];
      expect(dist).toBeLessThanOrEqual(4);
    }
  });

  it("trader refuels when tank drops below threshold and fuel is for sale", () => {
    const w = singleTraderWorld({ currentFuel: { good: "plasma", qty: 1 } });
    w.markets.haven.stock.plasma = 100;
    tickWorld(w);
    expect(w.traders.t.currentFuel!.qty).toBeGreaterThan(1);
  });

  it("trader at empty-fuel location stays stuck rather than crashing", () => {
    const w = singleTraderWorld({ currentFuel: { good: "plasma", qty: 0 } });
    for (const m of Object.values(w.markets)) m.stock.plasma = 0;
    const reports = tickN(w, 5);
    expect(w.traders.t.state).toBe("idle");
    expect(reports.at(-1)!.traderEvents.some(e => e.trader === "t" && e.kind === "stuck")).toBe(true);
  });

  it("fuel demand from traders pulls fuel stock down at trade hubs", () => {
    const noTraders = createWorld({ traders: {} });
    const withTraders = createWorld();
    tickN(noTraders, 100);
    tickN(withTraders, 100);
    expect(withTraders.markets.ironhold.stock.plasma).toBeLessThan(noTraders.markets.ironhold.stock.plasma);
  });
});

describe("fuel — multi-fuel preference", () => {
  it("hybrid ship prefers higher-priority fuel when available", () => {
    const w = singleTraderWorld({
      fuelCapacity: 30,
      fuelTypes: [
        { good: "antimatter", perDistance: 0.3 },
        { good: "plasma",     perDistance: 0.8 },
      ],
      currentFuel: { good: "plasma", qty: 5 },
      location: "ironhold",
    });
    w.markets.ironhold.stock.antimatter = 50;
    w.markets.ironhold.stock.plasma = 50;
    tickWorld(w);
    expect(w.traders.t.currentFuel!.good).toBe("antimatter");
  });

  it("hybrid ship falls back to lower-priority fuel when preferred is unavailable", () => {
    const w = singleTraderWorld({
      fuelCapacity: 30,
      fuelTypes: [
        { good: "antimatter", perDistance: 0.3 },
        { good: "plasma",     perDistance: 0.8 },
      ],
      currentFuel: { good: "plasma", qty: 3 },
      location: "haven",
    });
    w.markets.haven.stock.antimatter = 0;
    w.markets.haven.stock.plasma = 50;
    tickWorld(w);
    expect(w.traders.t.currentFuel!.good).toBe("plasma");
    expect(w.traders.t.currentFuel!.qty).toBeGreaterThan(3);
  });

  it("switching fuels dumps the remaining incompatible fuel", () => {
    const w = singleTraderWorld({
      fuelCapacity: 30,
      fuelTypes: [
        { good: "antimatter", perDistance: 0.3 },
        { good: "plasma",     perDistance: 0.8 },
      ],
      currentFuel: { good: "plasma", qty: 8 },
      location: "ironhold",
    });
    w.markets.ironhold.stock.antimatter = 100;
    tickWorld(w);
    expect(w.traders.t.currentFuel!.good).toBe("antimatter");
    expect(w.traders.t.currentFuel!.qty).toBeLessThanOrEqual(30);
  });

  it("ship's fuelTypes list is independent — different ships can have different paths", () => {
    const w = createWorld();
    const falcon = w.traders.t_falcon;
    const pelican = w.traders.t_pelican;
    expect(falcon.fuelTypes.map(f => f.good)).toEqual(["antimatter", "plasma"]);
    expect(pelican.fuelTypes.map(f => f.good)).toEqual(["plasma"]);
  });
});
