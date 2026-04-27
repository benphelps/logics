import { describe, expect, it } from "vitest";
import { createWorld } from "./world";
import { getGuidedHint, hintTarget } from "./suggestions";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "./crew";
import { buyAtLocation } from "./traders";
import { acceptJob } from "./jobs";
import { tickWorld } from "./tick";
import type { CrewMember } from "./types";

function playerShip(w: ReturnType<typeof createWorld>) {
  return w.traders[w.player!.shipIds[0]];
}

function assignAutoCrew(ship: ReturnType<typeof playerShip>): void {
  const crew = (role: CrewMember["role"], name: string): CrewMember => ({
    id: `test_${role}`,
    role,
    name,
    tier: 1,
    hireCost: 0,
    wagePerTick: 0,
    modifiers: {},
  });
  ship.crew = {
    ...(ship.crew ?? {}),
    captain: crew("captain", "Test Captain"),
    navigator: crew("navigator", "Test Navigator"),
  };
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

  it("plans a multi-good loadout when several products profit on the same route", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };

    for (const market of Object.values(w.markets)) {
      for (const gid of Object.keys(w.goods)) {
        market.stock[gid] = 0;
        market.prices[gid] = w.goods[gid].basePrice;
      }
    }
    w.markets.haven.stock.grain = 20;
    w.markets.haven.stock.protein = 20;
    w.markets.haven.prices.grain = 2;
    w.markets.haven.prices.protein = 2;
    w.markets.haven.prices.plasma = 15;
    w.markets.ironhold.stock.plasma = 100;
    w.markets.ironhold.prices.grain = 100;
    w.markets.ironhold.prices.protein = 100;

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.dst).toBe("ironhold");
      expect(hint.buys.map(b => b.good).sort()).toEqual(["grain", "protein"]);
    }
    const target = hintTarget(hint);
    expect(target.buyGoods?.grain).toBe(20);
    expect(target.buyGoods?.protein).toBe(20);
  });

  it("keeps a multi-good route plan visible after partial buys", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };

    for (const market of Object.values(w.markets)) {
      for (const gid of Object.keys(w.goods)) {
        market.stock[gid] = 0;
        market.prices[gid] = w.goods[gid].basePrice;
      }
    }
    for (const gid of ["grain", "protein", "vatmeat"]) {
      w.markets.haven.stock[gid] = 10;
      w.markets.haven.prices[gid] = 2;
      w.markets.ironhold.prices[gid] = 100;
    }
    w.markets.haven.prices.plasma = 15;
    w.markets.ironhold.stock.plasma = 100;

    let hint = getGuidedHint(w, ship);
    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.buys.map(b => b.good).sort()).toEqual(["grain", "protein", "vatmeat"]);
    }

    expect(buyAtLocation(w, ship, "grain", 10).ok).toBe(true);
    expect(buyAtLocation(w, ship, "protein", 10).ok).toBe(true);

    hint = getGuidedHint(w, ship);
    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.dst).toBe("ironhold");
      expect(hint.loaded?.map(l => l.good).sort()).toEqual(["grain", "protein"]);
    }
    const target = hintTarget(hint);
    expect(target.buyGoods?.vatmeat).toBe(10);
    expect(target.buyGoods?.grain).toBeUndefined();
    expect(target.buyGoods?.protein).toBeUndefined();
  });

  it("refuels before continuing a partially loaded route when the tank is low", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };

    for (const market of Object.values(w.markets)) {
      for (const gid of Object.keys(w.goods)) {
        market.stock[gid] = 0;
        market.prices[gid] = w.goods[gid].basePrice;
      }
    }
    w.markets.haven.stock.grain = 10;
    w.markets.haven.stock.protein = 10;
    w.markets.haven.stock.plasma = 100;
    w.markets.haven.prices.grain = 2;
    w.markets.haven.prices.protein = 2;
    w.markets.haven.prices.plasma = 15;
    w.markets.ironhold.stock.plasma = 100;
    w.markets.ironhold.prices.grain = 100;
    w.markets.ironhold.prices.protein = 100;

    expect(buyAtLocation(w, ship, "grain", 10).ok).toBe(true);
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity * 0.4 };

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("refuel");
    if (hint.kind === "refuel") {
      expect(hint.reason).toContain("before flying to");
    }
  });

  it("plans rescue acceptance before buying fuel and departing", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };

    for (const market of Object.values(w.markets)) {
      for (const gid of Object.keys(w.goods)) market.prices[gid] = w.goods[gid].basePrice;
    }
    w.markets.haven.stock.plasma = 30;
    w.markets.ironhold.stock.plasma = 100;
    w.jobs.j_rescue = {
      id: "j_rescue", kind: "rescue", tier: "high", good: "plasma", qty: 12,
      destination: "ironhold", reward: 12_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 30, acceptedBy: null, delivered: 0, rescueTarget: "npc_1",
    };

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.acceptJobIds).toContain("j_rescue");
      expect(hint.buys.some(b => b.good === "plasma" && b.qty >= 12)).toBe(true);
    }
  });

  it("can accept several local contracts before fetching their goods", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
    w.markets.haven.stock.grain = 0;
    w.markets.haven.stock.polymer = 0;
    w.markets.verdant.stock.grain = 20;
    w.markets.verdant.stock.polymer = 20;
    w.markets.verdant.stock.plasma = 100;
    w.markets.verdant.prices.grain = 2;
    w.markets.verdant.prices.polymer = 2;
    w.jobs.j_grain = {
      id: "j_grain", kind: "shortage", tier: "high", good: "grain", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 40, acceptedBy: null, delivered: 0,
    };
    w.jobs.j_polymer = {
      id: "j_polymer", kind: "shortage", tier: "medium", good: "polymer", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 60, acceptedBy: null, delivered: 0,
    };

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.acceptJobIds.sort()).toEqual(["j_grain", "j_polymer"]);
      expect(hint.futureBuys?.map(b => b.good).sort()).toEqual(["grain", "polymer"]);
      expect(hint.dst).toBe("verdant");
    }
  });

  it("keeps the displayed guidance stable when toggling manual and auto", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
    w.markets.haven.stock.grain = 0;
    w.markets.haven.stock.polymer = 0;
    w.markets.verdant.stock.grain = 20;
    w.markets.verdant.stock.polymer = 20;
    w.markets.verdant.stock.plasma = 100;
    w.markets.verdant.prices.grain = 2;
    w.markets.verdant.prices.polymer = 2;
    w.jobs.j_grain = {
      id: "j_grain", kind: "shortage", tier: "high", good: "grain", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 40, acceptedBy: null, delivered: 0,
    };
    w.jobs.j_polymer = {
      id: "j_polymer", kind: "shortage", tier: "medium", good: "polymer", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 60, acceptedBy: null, delivered: 0,
    };

    ship.pilot = "manual";
    const manualHint = getGuidedHint(w, ship);
    const manualTarget = hintTarget(manualHint);
    ship.pilot = "auto";
    const autoHint = getGuidedHint(w, ship);
    const autoTarget = hintTarget(autoHint);

    expect(autoHint.kind).toBe(manualHint.kind);
    expect(autoTarget).toEqual(manualTarget);
  });

  it("can ask for the actual auto plan and match the next auto action", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
    assignAutoCrew(ship);
    ship.pilot = "auto";

    w.markets.haven.stock.grain = 0;
    w.markets.haven.stock.polymer = 0;
    w.markets.verdant.stock.grain = 20;
    w.markets.verdant.stock.polymer = 20;
    w.markets.verdant.stock.plasma = 100;
    w.markets.verdant.prices.grain = 2;
    w.markets.verdant.prices.polymer = 2;
    w.jobs.j_grain = {
      id: "j_grain", kind: "shortage", tier: "high", good: "grain", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 40, acceptedBy: null, delivered: 0,
    };
    w.jobs.j_polymer = {
      id: "j_polymer", kind: "shortage", tier: "medium", good: "polymer", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 60, acceptedBy: null, delivered: 0,
    };

    const advisoryHint = getGuidedHint(w, ship);
    const actualHint = getGuidedHint(w, ship, { mode: "actual" });

    expect(advisoryHint.kind).toBe("route_plan");
    expect(actualHint.kind).toBe("speculate");
    if (actualHint.kind !== "speculate") return;

    const report = tickWorld(w);
    const event = report.traderEvents.find(e => e.trader === ship.id && e.kind === "depart");
    expect(event?.to).toBe(actualHint.via);

    while (w.traders[ship.id].state === "transit") tickWorld(w);
    const firstBuyHint = getGuidedHint(w, w.traders[ship.id], { mode: "actual" });
    expect(firstBuyHint.kind).toBe("buy_for_route");
    if (firstBuyHint.kind !== "buy_for_route") return;
    const firstBuyReport = tickWorld(w);
    const firstBuy = firstBuyReport.traderEvents.find(e => e.trader === ship.id && e.kind === "buy");
    expect(firstBuy?.good).toBe(firstBuyHint.good);
    expect(Math.round(firstBuy?.qty ?? 0)).toBe(firstBuyHint.qty);

    while (w.traders[ship.id].state === "transit") tickWorld(w);
    const secondBuyHint = getGuidedHint(w, w.traders[ship.id], { mode: "actual" });
    expect(secondBuyHint.kind).toBe("buy_for_route");
    if (secondBuyHint.kind !== "buy_for_route") return;
    const secondBuyReport = tickWorld(w);
    const secondBuy = secondBuyReport.traderEvents.find(e => e.trader === ship.id && e.kind === "buy");
    expect(secondBuy?.good).toBe(secondBuyHint.good);
    expect(Math.round(secondBuy?.qty ?? 0)).toBe(secondBuyHint.qty);
  });

  it("keeps suggesting remaining local contracts after one grouped contract is accepted", () => {
    const w = createWorld();
    const ship = playerShip(w);
    ship.funds = 100_000;
    ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
    w.markets.haven.stock.grain = 0;
    w.markets.haven.stock.polymer = 0;
    w.markets.haven.stock.protein = 0;
    w.markets.verdant.stock.grain = 20;
    w.markets.verdant.stock.polymer = 20;
    w.markets.verdant.stock.protein = 20;
    w.markets.verdant.stock.plasma = 100;
    w.markets.verdant.prices.grain = 2;
    w.markets.verdant.prices.polymer = 2;
    w.markets.verdant.prices.protein = 2;
    w.jobs.j_grain = {
      id: "j_grain", kind: "shortage", tier: "high", good: "grain", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 40, acceptedBy: null, delivered: 0,
    };
    w.jobs.j_polymer = {
      id: "j_polymer", kind: "shortage", tier: "medium", good: "polymer", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 60, acceptedBy: null, delivered: 0,
    };
    w.jobs.j_protein = {
      id: "j_protein", kind: "shortage", tier: "medium", good: "protein", qty: 10,
      destination: "haven", reward: 8_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 70, acceptedBy: null, delivered: 0,
    };

    expect(acceptJob(w, "j_grain", ship.id).ok).toBe(true);

    const hint = getGuidedHint(w, ship);

    expect(hint.kind).toBe("route_plan");
    if (hint.kind === "route_plan") {
      expect(hint.acceptJobIds.sort()).toEqual(["j_polymer", "j_protein"]);
      expect(hint.futureBuys?.map(b => b.good).sort()).toEqual(["grain", "polymer", "protein"]);
    }
    const target = hintTarget(hint);
    expect(target.acceptJobIds?.sort()).toEqual(["j_polymer", "j_protein"]);
  });
});
