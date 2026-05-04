import { describe, expect, it } from "vitest";
import { createWorld } from "../world";
import { tickN } from "../tick";
import { hullRepairCost, repairShip, HULL_REPAIR_PER_POINT } from "../traders";
import { isMilestoneMet, MILESTONES } from "../milestones";
import type { Trader } from "../types";

function playerShip(world: ReturnType<typeof createWorld>): Trader {
  const id = world.player!.shipIds[0];
  return world.traders[id];
}

describe("hullRepairCost", () => {
  it("returns 0 when hull is at base", () => {
    const w = createWorld();
    const ship = playerShip(w);
    expect(hullRepairCost(ship)).toBe(0);
  });

  it("scales with damage points", () => {
    const w = createWorld();
    const ship = playerShip(w);
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 5;
    expect(hullRepairCost(ship)).toBe(5 * HULL_REPAIR_PER_POINT);
  });
});

describe("repairShip with hull damage", () => {
  it("repairs both maintenance debt and hull damage in one settlement", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.state = "idle";
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 4;
    ship.maintenanceDebt = 1000;
    ship.funds = 50_000;
    const cost = ship.maintenanceDebt + 4 * HULL_REPAIR_PER_POINT;
    const result = repairShip(w, ship);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.paid).toBe(cost);
    expect(ship.hull).toBe(base);
    expect(ship.maintenanceDebt).toBe(0);
    expect(ship.funds).toBe(50_000 - cost);
  });

  it("rejects repair when funds insufficient", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.state = "idle";
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 10;
    ship.funds = 100;
    const result = repairShip(w, ship);
    expect(result.ok).toBe(false);
    expect(ship.hull).toBe(base - 10);
  });

  it("rejects repair when ship is in transit", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.state = "transit";
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 5;
    ship.funds = 50_000;
    const result = repairShip(w, ship);
    expect(result.ok).toBe(false);
  });

  it("deposits hull-repair credits into the local station treasury", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.state = "idle";
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 3;
    ship.funds = 50_000;
    const market = w.markets[ship.location];
    const before = market.treasury;
    repairShip(w, ship);
    expect(market.treasury).toBe(before + 3 * HULL_REPAIR_PER_POINT);
  });
});

describe("mercenaryOffers milestone", () => {
  it("is locked at zero actions", () => {
    const w = createWorld();
    expect(isMilestoneMet(w, "mercenaryOffers")).toBe(false);
  });

  it("unlocks once player crosses the action threshold", () => {
    const w = createWorld();
    if (!w.player) throw new Error("player required");
    w.player.manualActionCount = MILESTONES.mercenaryOffers;
    expect(isMilestoneMet(w, "mercenaryOffers")).toBe(true);
  });

  it("milestone threshold is higher than the captain gate (mercenary unlocks last)", () => {
    expect(MILESTONES.mercenaryOffers).toBeGreaterThan(MILESTONES.captainOffers);
  });
});

describe("encounter integration with repair", () => {
  it("ship can recover from hull damage after a tick or two of repair", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.state = "idle";
    const base = ship.baseHull ?? ship.hull ?? 30;
    ship.hull = base - 7;
    ship.funds = 100_000;
    const result = repairShip(w, ship);
    expect(result.ok).toBe(true);
    expect(ship.hull).toBe(base);
    // Subsequent ticks shouldn't break anything.
    tickN(w, 5);
    expect(ship.hull).toBeLessThanOrEqual(base);
  });
});
