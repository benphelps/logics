import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import { buyAtLocation, executeTrade, listTradeOptions, refuelManual, sellAtLocation, travelTo } from "./traders";

describe("player layer v1", () => {
  it("createWorld() defaults include a player with a manual ship", () => {
    const w = createWorld();
    expect(w.player).not.toBeNull();
    expect(w.player!.funds).toBe(50_000);
    expect(w.player!.shipIds.length).toBe(1);
    const ship = w.traders[w.player!.shipIds[0]];
    expect(ship).toBeDefined();
    expect(ship.pilot).toBe("manual");
    expect(ship.location).toBe("haven");
  });

  it("createWorld({ player: null }) produces a no-player world", () => {
    const w = createWorld({ player: null });
    expect(w.player).toBeNull();
    for (const t of Object.values(w.traders)) {
      expect(t.pilot).toBe("npc");
    }
  });

  it("manual ships do not auto-trade", () => {
    const w = createWorld();
    const playerId = w.player!.shipIds[0];
    const before = w.traders[playerId];
    const startCargo = before.cargo;
    const startState = before.state;
    const startFuel = before.currentFuel?.qty;

    tickN(w, 50);

    const after = w.traders[playerId];
    expect(after.cargo).toEqual(startCargo);
    expect(after.state).toBe(startState);
    expect(after.currentFuel?.qty).toBe(startFuel);
  });

  it("listTradeOptions returns ranked options for an idle ship", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    tickN(w, 30);
    const opts = listTradeOptions(w, ship);
    expect(opts.length).toBeGreaterThan(0);
    for (let i = 1; i < opts.length; i++) {
      expect(opts[i].profitPerTick).toBeLessThanOrEqual(opts[i - 1].profitPerTick);
    }
    for (const o of opts) {
      expect(o.totalProfit).toBeGreaterThan(0);
    }
  });

  it("executeTrade departs the ship with cargo + sets destination", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    tickN(w, 30);

    const opts = listTradeOptions(w, ship);
    expect(opts.length).toBeGreaterThan(0);
    const choice = opts[0];

    const result = executeTrade(w, ship, choice);
    expect(result.ok).toBe(true);
    expect(ship.state).toBe("transit");
    expect(ship.destination).toBe(choice.to);
    expect(ship.cargo).toEqual({ good: choice.good, qty: choice.qty });
    expect(ship.ticksRemaining).toBe(choice.travelTicks);
  });

  it("executeTrade fails cleanly when the ship can't afford the cargo", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1;
    tickN(w, 30);

    const opts = listTradeOptions(w, ship);
    if (opts.length === 0) return;
    const result = executeTrade(w, ship, opts[0]);
    expect(result.ok).toBe(false);
  });
});

describe("player primitives — manual buy / sell / refuel / travel", () => {
  it("buyAtLocation loads cargo, deducts funds and stock", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const fundsBefore = ship.funds;
    const stockBefore = w.markets.haven.stock.protein;
    const r = buyAtLocation(w, ship, "protein", 10);
    expect(r.ok).toBe(true);
    expect(ship.cargo).toEqual({ good: "protein", qty: 10 });
    expect(ship.funds).toBeLessThan(fundsBefore);
    expect(w.markets.haven.stock.protein).toBe(stockBefore - 10);
  });

  it("buyAtLocation refuses mismatched cargo", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    expect(buyAtLocation(w, ship, "protein", 5).ok).toBe(true);
    expect(buyAtLocation(w, ship, "fiber", 5).ok).toBe(false);
  });

  it("buyAtLocation refuses cargo over capacity", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    expect(buyAtLocation(w, ship, "protein", 999).ok).toBe(false);
  });

  it("sellAtLocation pays the trader after tax", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    buyAtLocation(w, ship, "protein", 10);
    const fundsBefore = ship.funds;
    const r = sellAtLocation(w, ship);
    expect(r.ok).toBe(true);
    expect(ship.cargo).toBeNull();
    expect(ship.funds).toBeGreaterThan(fundsBefore);
  });

  it("refuelManual fills the tank when fuel is available", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.currentFuel = { good: "plasma", qty: 5 };
    w.markets.haven.stock.plasma = 100;
    const r = refuelManual(w, ship);
    expect(r.ok).toBe(true);
    expect(ship.currentFuel!.qty).toBe(ship.fuelCapacity);
  });

  it("travelTo deducts fuel, sets destination + transit", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const fuelBefore = ship.currentFuel!.qty;
    const r = travelTo(w, ship, "verdant");
    expect(r.ok).toBe(true);
    expect(ship.state).toBe("transit");
    expect(ship.destination).toBe("verdant");
    expect(ship.currentFuel!.qty).toBeLessThan(fuelBefore);
  });

  it("travelTo refuses when fuel is insufficient", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.currentFuel = { good: "plasma", qty: 1 };
    const r = travelTo(w, ship, "saffron");
    expect(r.ok).toBe(false);
  });

  it("manual ship does NOT auto-sell on arrival — cargo stays loaded", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    tickN(w, 30);

    const buyOk = buyAtLocation(w, ship, "protein", 30).ok;
    expect(buyOk).toBe(true);
    const fundsBeforeTravel = ship.funds;

    travelTo(w, ship, "ironhold");
    expect(ship.state).toBe("transit");

    while (ship.state === "transit") tickN(w, 1);

    expect(ship.location).toBe("ironhold");
    expect(ship.cargo).toEqual({ good: "protein", qty: 30 });
    // Funds should only have decreased (docking fee + maintenance). No auto-sale.
    expect(ship.funds).toBeLessThan(fundsBeforeTravel);
  });

  it("NPC ship continues to auto-sell on arrival (sim throughput unchanged)", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc");
    expect(npc).toBeDefined();
    if (!npc) return;
    npc.cargo = { good: "grain", qty: 10 };
    npc.location = "verdant";
    npc.state = "transit";
    npc.destination = "haven";
    npc.ticksRemaining = 1;

    const havenGrainBefore = w.markets.haven.stock.grain;
    tickN(w, 1);

    expect(npc.cargo).toBeNull();
    expect(npc.location).toBe("haven");
    expect(w.markets.haven.stock.grain).toBeGreaterThan(havenGrainBefore);
  });
});
