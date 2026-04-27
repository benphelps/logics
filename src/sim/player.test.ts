import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import { executeTrade, listTradeOptions } from "./traders";

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
