import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import { MAX_NO_OPPORTUNITY_TICKS, NPC_OPERATING_FLOAT } from "./traders";
import type { LocationDef, Trader } from "./types";

describe("trader-driven convergence", () => {
  it("traders measurably reduce steady-state shortage volume", () => {
    const noTraders = createWorld({ traders: {} });
    const withTraders = createWorld();

    tickN(noTraders, 50);
    tickN(withTraders, 50);

    const noShort = tickN(noTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);
    const yesShort = tickN(withTraders, 100).flatMap(r => r.shortages).reduce((s, e) => s + e.missing, 0);

    expect(yesShort).toBeLessThan(noShort);
  });

  it("traders end up profitable on average over a long run", () => {
    const w = createWorld();
    const startFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    tickN(w, 500);
    const endFunds = Object.values(w.traders).reduce((s, t) => s + t.funds, 0);
    const cargoValue = Object.values(w.traders).reduce((s, t) => {
      let v = 0;
      for (const lot of t.cargo) v += lot.qty * w.goods[lot.good].basePrice;
      return s + v;
    }, 0);
    expect(endFunds + cargoValue).toBeGreaterThan(startFunds);
  });

  it("flattens prices for a heavily traded good toward the base price", () => {
    const meanAbsDev = (w: ReturnType<typeof createWorld>, good: string) => {
      const base = w.goods[good].basePrice;
      const prices = Object.values(w.markets).map(m => m.prices[good]);
      return prices.reduce((s, p) => s + Math.abs(p - base), 0) / prices.length;
    };
    const noTrade = createWorld({ traders: {} });
    const trade = createWorld();
    tickN(noTrade, 200);
    tickN(trade, 200);
    expect(meanAbsDev(trade, "grain")).toBeLessThan(meanAbsDev(noTrade, "grain"));
  });

  it("repositions an autonomous trader after a short no-opportunity wait", () => {
    const locations: Record<string, LocationDef> = {
      a: {
        id: "a",
        name: "A",
        position: { x: 0, y: 0 },
        population: 1,
        traits: { techLevel: 1, tags: [] },
        primaryExports: [],
        primaryImports: [],
        produces: [],
        consumes: [],
        targetStock: {},
      },
      b: {
        id: "b",
        name: "B",
        position: { x: 5, y: 0 },
        population: 1,
        traits: { techLevel: 1, tags: [] },
        primaryExports: [],
        primaryImports: [],
        produces: [],
        consumes: [],
        targetStock: {},
      },
    };
    const trader: Trader = {
      id: "npc",
      name: "NPC",
      capacity: 60,
      speed: 100,
      fuelCapacity: 100,
      fuelTypes: [{ good: "plasma", perDistance: 1 }],
      currentFuel: { good: "plasma", qty: 100 },
      funds: 1000,
      location: "a",
      state: "idle",
      cargo: [],
      destination: null,
      ticksRemaining: 0,
      pilot: "npc",
      log: [],
    };
    const w = createWorld({
      locations,
      lanes: { a: { b: 1 }, b: { a: 1 } },
      traders: { npc: trader },
      player: null,
    });

    tickN(w, MAX_NO_OPPORTUNITY_TICKS - 1);
    expect(w.traders.npc.state).toBe("idle");
    expect(w.traders.npc.location).toBe("a");

    const report = tickN(w, 1).at(-1)!;
    expect(w.traders.npc.state).toBe("transit");
    expect(w.traders.npc.destination).toBe("b");
    expect(report.traderEvents.some(e => e.trader === "npc" && e.kind === "depart" && e.to === "b")).toBe(true);
  });

  it("gives bankrupt stranded NPCs enough operating credit to rejoin the economy", () => {
    const w = createWorld();
    const ship = w.traders.t_pelican;
    ship.location = "haven";
    ship.state = "idle";
    ship.cargo = [];
    ship.funds = 0;
    ship.currentFuel = { good: "plasma", qty: 0 };
    ship.noOpportunityTicks = MAX_NO_OPPORTUNITY_TICKS;
    w.markets.haven.stock.plasma = 100;

    tickN(w, 1);
    expect(ship.currentFuel!.qty).toBeGreaterThan(0);
    expect(ship.funds).toBeGreaterThan(NPC_OPERATING_FLOAT - ship.capacity);
  });

});
