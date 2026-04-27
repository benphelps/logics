import { describe, expect, it } from "vitest";
import { createWorld } from "./world";
import { getGuidedHint } from "./suggestions";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "./crew";

function playerShip(w: ReturnType<typeof createWorld>) {
  return w.traders[w.player!.shipIds[0]];
}

describe("suggestion engine edge cases", () => {
  it("suggests selling local cargo even when the ship is out of fuel", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.currentFuel = { good: "plasma", qty: 0 };
    ship.cargo = [{ good: "protein", qty: 5, source: "haven", unitPrice: 10, purchasedAt: 0 }];
    for (const market of Object.values(w.markets)) market.stock.plasma = 0;

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("sell_here");
    if (hint.kind === "sell_here") expect(hint.good).toBe("protein");
  });

  it("does not suggest accepting a fetch contract when the return leg would strand the ship", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: 4 };
    w.markets.haven.stock.plasma = 0;
    w.markets.haven.stock.grain = 0;
    for (const loc of ["ironhold", "verdant", "saffron"]) {
      w.markets[loc].stock.grain = 100;
      w.markets[loc].stock.plasma = 0;
    }
    w.jobs.j_fetch = {
      id: "j_fetch", kind: "shortage", tier: "high", good: "grain", qty: 5,
      destination: "haven", reward: 10_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 100, acceptedBy: null, delivered: 0,
    };

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).not.toBe("accept_job");
  });

  it("does not suggest travel-based work while maintenance debt grounds the ship", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.maintenanceDebt = MAINTENANCE_DEBT_TRAVEL_BLOCK;
    w.jobs.j_fetch = {
      id: "j_fetch", kind: "shortage", tier: "high", good: "grain", qty: 5,
      destination: "haven", reward: 10_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 100, acceptedBy: null, delivered: 0,
    };

    const hint = getGuidedHint(w, ship);

    expect(["buy_for_route", "travel_to_sell", "speculate", "accept_job"]).not.toContain(hint.kind);
  });
});
