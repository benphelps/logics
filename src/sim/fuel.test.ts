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
    fuelPerDistance: 1,
    fuelTank: 20,
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

describe("fuel", () => {
  it("trader consumes fuel proportional to distance on departure", () => {
    const w = singleTraderWorld({});
    const startFuel = w.traders.t.fuelTank;
    for (let i = 0; i < 30 && w.traders.t.state !== "transit"; i++) tickWorld(w);
    expect(w.traders.t.state).toBe("transit");
    const distance = w.distances.haven[w.traders.t.destination!];
    expect(startFuel - w.traders.t.fuelTank).toBeCloseTo(distance * w.traders.t.fuelPerDistance, 5);
  });

  it("trader cannot depart for a destination it lacks fuel for", () => {
    const w = singleTraderWorld({ fuelCapacity: 4, fuelTank: 4 });
    const reachable = Object.entries(w.distances.haven)
      .filter(([dst, d]) => dst !== "haven" && d <= 4);
    expect(reachable.length).toBeGreaterThan(0);
    tickN(w, 5);
    if (w.traders.t.state === "transit") {
      const dist = w.distances.haven[w.traders.t.destination!];
      expect(dist).toBeLessThanOrEqual(4);
    }
  });

  it("trader refuels when tank drops below threshold and fuel is for sale", () => {
    const w = singleTraderWorld({ fuelTank: 1 });
    w.markets.haven.stock.plasma = 100;
    tickWorld(w);
    expect(w.traders.t.fuelTank).toBeGreaterThan(1);
  });

  it("trader at empty-fuel location stays stuck rather than crashing", () => {
    const w = singleTraderWorld({ fuelTank: 0 });
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
    const ironholdNo = noTraders.markets.ironhold.stock.plasma;
    const ironholdYes = withTraders.markets.ironhold.stock.plasma;
    expect(ironholdYes).toBeLessThan(ironholdNo);
  });
});
