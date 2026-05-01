import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import {
  fireCrew, hireCrew, MAINTENANCE_DEBT_TRAVEL_BLOCK, recomputeShipStats, totalCrewWage,
} from "./crew";
import { executeTrade, listTradeOptions, repairShip, travelTo } from "./traders";
import { generateHires, listHiresAt } from "./hires";
import { unlockAllMilestonesForTests } from "./milestones";
import type { CrewModifiers, CrewRole, Hire, World } from "./types";

function getPlayerShip(w: ReturnType<typeof createWorld>) {
  return w.traders[w.player!.shipIds[0]];
}

// Synthesize a hire offer at a given location for tests. Bypasses RNG-based
// generation so test outcomes are predictable.
function postTestHire(w: World, location: string, role: CrewRole, opts: {
  hireCost?: number; wagePerTick?: number; modifiers?: CrewModifiers; tier?: number; expiresAt?: number;
} = {}): Hire {
  const id = `t${w.nextHireId++}`;
  const h: Hire = {
    id, role,
    name: `Test ${role}`,
    tier: opts.tier ?? 1,
    hireCost: opts.hireCost ?? 25_000,
    wagePerTick: opts.wagePerTick ?? 4,
    modifiers: opts.modifiers ?? {},
    sex: "nonbinary",
    age: "adult",
    race: "human",
    location,
    postedTick: w.tick,
    expiresAt: opts.expiresAt ?? (w.tick + 100),
  };
  w.hires[id] = h;
  return h;
}

describe("crew: hire / fire / modifiers", () => {
  it("hireCrew consumes the offer, deducts cost, sets crew slot, recomputes stats", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    recomputeShipStats(ship);
    const baseFuel = ship.fuelCapacity;
    const fundsBefore = ship.funds;
    const offer = postTestHire(w, ship.location, "navigator", { hireCost: 240_000, modifiers: { fuelCapacityBonus: 8 } });
    expect(hireCrew(w, ship, offer.id).ok).toBe(true);
    expect(ship.crew?.navigator?.id).toBe(offer.id);
    expect(ship.funds).toBe(fundsBefore - 240_000);
    expect(ship.fuelCapacity).toBe(baseFuel + 8);
    expect(w.hires[offer.id]).toBeUndefined();        // offer consumed
  });

  it("hireCrew rejects when can't afford", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 100;
    const offer = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    expect(hireCrew(w, ship, offer.id).ok).toBe(false);
    expect(ship.crew?.captain).toBeUndefined();
    expect(w.hires[offer.id]).toBeDefined();          // still on the board
  });

  it("hireCrew rejects when ship is in transit", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.state = "transit";
    const offer = postTestHire(w, ship.location, "captain");
    expect(hireCrew(w, ship, offer.id).ok).toBe(false);
  });

  it("hireCrew rejects an offer at a different station", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 100_000;
    const offer = postTestHire(w, "verdant", "captain", { hireCost: 25_000 });
    expect(ship.location).not.toBe("verdant");
    const r = hireCrew(w, ship, offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("different station");
  });

  it("fireCrew clears slot and reverts stats", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    const baseCargo = ship.capacity;
    const offer = postTestHire(w, ship.location, "mechanic", { hireCost: 60_000, modifiers: { cargoCapacityBonus: 4 } });
    expect(hireCrew(w, ship, offer.id).ok).toBe(true);
    expect(ship.capacity).toBe(baseCargo + 4);
    fireCrew(ship, "mechanic");
    expect(ship.crew?.mechanic).toBeUndefined();
    expect(ship.capacity).toBe(baseCargo);
  });

  it("hiring a replacement in the same role swaps cleanly", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    const t1 = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    const t2 = postTestHire(w, ship.location, "captain", { hireCost: 75_000, tier: 2, modifiers: { speedBonus: 1 } });
    expect(hireCrew(w, ship, t1.id).ok).toBe(true);
    expect(ship.crew?.captain?.id).toBe(t1.id);
    expect(hireCrew(w, ship, t2.id).ok).toBe(true);
    expect(ship.crew?.captain?.id).toBe(t2.id);
    expect(ship.speed).toBeGreaterThanOrEqual(2);
  });
});

describe("crew: auto-pilot gating", () => {
  it("auto-pilot does NOT trade without a pilot (silent idle)", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.pilot = "auto";
    const fundsBefore = ship.funds;
    tickN(w, 50);
    const traded = ship.log.some(e => e.kind === "buy" || e.kind === "sell");
    expect(traded).toBe(false);
    expect(ship.funds).toBeLessThanOrEqual(fundsBefore);
  });

  it("navigator alone does NOT unlock auto-pilot", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 500_000;
    const nav = postTestHire(w, ship.location, "navigator", { hireCost: 18_000 });
    expect(hireCrew(w, ship, nav.id).ok).toBe(true);
    ship.pilot = "auto";
    const fundsBefore = ship.funds;
    tickN(w, 50);
    const traded = ship.log.some(e => e.kind === "buy" || e.kind === "sell");
    expect(traded).toBe(false);
    expect(ship.funds).toBeLessThanOrEqual(fundsBefore);
  });

  it("auto-pilot WITH pilot accepts matching contracts on arrival without a navigator", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    tickN(w, 30);
    const cap = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    expect(hireCrew(w, ship, cap.id).ok).toBe(true);

    const option = listTradeOptions(w, ship, undefined, 1.0)[0];
    expect(option).toBeDefined();
    w.jobs.j_auto_contract = {
      id: "j_auto_contract", kind: "shortage", tier: "high", good: option.good, qty: Math.max(1, Math.min(3, option.qty)),
      destination: option.to, reward: 100_000, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 100, acceptedBy: null, delivered: 0,
    };

    ship.pilot = "auto";
    tickWorld(w);
    tickN(w, option.travelTicks + 1);

    const accepted = ship.log.filter(e => e.kind === "job_accepted").length;
    expect(accepted).toBeGreaterThan(0);
    expect(ship.log.some(e => e.kind === "job_completed")).toBe(true);
  });

  it("pilot-only auto-pilot preloads parallel contract cargo", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    tickN(w, 30);
    const baseline = listTradeOptions(w, ship, undefined, 1.0)[0];
    expect(baseline).toBeDefined();

    const cap = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    expect(hireCrew(w, ship, cap.id).ok).toBe(true);

    const preloadGood = ["protein", "fiber", "medkits"].find(g => g !== baseline.good)!;
    w.markets[ship.location].stock[preloadGood] = 3;
    w.markets[ship.location].prices[preloadGood] = 10_000;
    w.jobs.j_parallel = {
      id: "j_parallel", kind: "shortage", tier: "high", good: preloadGood, qty: 3,
      destination: baseline.to, reward: 0, penalty: 0, postedTick: w.tick,
      expiresAt: w.tick + 100, acceptedBy: ship.id, delivered: 0,
    };

    ship.pilot = "auto";
    tickWorld(w);

    expect(ship.state).toBe("transit");
    expect(ship.cargo.some(l => l.good === preloadGood)).toBe(true);
  });
});

describe("crew: maintenance debt + repair", () => {
  it("debt accumulates without a mechanic", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    const cap = postTestHire(w, ship.location, "captain");
    hireCrew(w, ship, cap.id);
    ship.pilot = "auto";
    tickN(w, 50);
    expect(ship.maintenanceDebt ?? 0).toBeGreaterThan(0);
  });

  it("debt does NOT accumulate with a mechanic", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    const mech = postTestHire(w, ship.location, "mechanic");
    hireCrew(w, ship, mech.id);
    tickN(w, 50);
    expect(ship.maintenanceDebt ?? 0).toBe(0);
  });

  it("travelTo refuses when debt is over the threshold", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.maintenanceDebt = MAINTENANCE_DEBT_TRAVEL_BLOCK + 100;
    const r = travelTo(w, ship, "verdant");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("repair");
  });

  it("executeTrade refuses when debt is over the threshold", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    tickN(w, 30);
    const choice = listTradeOptions(w, ship, undefined, 1.0)[0];
    expect(choice).toBeDefined();

    ship.maintenanceDebt = MAINTENANCE_DEBT_TRAVEL_BLOCK;
    const r = executeTrade(w, ship, choice);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("repair");
    expect(ship.state).toBe("idle");
  });

  it("auto-pilot stays docked when maintenance debt grounds the ship", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 1_000_000;
    tickN(w, 30);
    expect(listTradeOptions(w, ship, undefined, 1.0).length).toBeGreaterThan(0);

    const cap = postTestHire(w, ship.location, "captain");
    expect(hireCrew(w, ship, cap.id).ok).toBe(true);
    ship.pilot = "auto";
    ship.maintenanceDebt = MAINTENANCE_DEBT_TRAVEL_BLOCK;
    const startLocation = ship.location;

    tickN(w, 5);

    expect(ship.state).toBe("idle");
    expect(ship.location).toBe(startLocation);
    expect(ship.cargo).toEqual([]);
  });

  it("repairShip pays debt from ship funds and clears it", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 50_000;
    ship.maintenanceDebt = 1000;
    const fundsBefore = ship.funds;
    const r = repairShip(w, ship);
    expect(r.ok).toBe(true);
    expect(ship.maintenanceDebt).toBe(0);
    expect(ship.funds).toBe(fundsBefore - 1000);
  });

  it("repairShip refuses when no debt", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    expect(repairShip(w, ship).ok).toBe(false);
  });
});

describe("crew: pricing + wages", () => {
  it("totalCrewWage sums all hired wages", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.funds = 500_000;
    const cap = postTestHire(w, ship.location, "captain", { wagePerTick: 4 });
    const mech = postTestHire(w, ship.location, "mechanic", { wagePerTick: 3 });
    hireCrew(w, ship, cap.id);
    hireCrew(w, ship, mech.id);
    expect(totalCrewWage(ship)).toBe(7);
  });
});

describe("hires: dynamic pool", () => {
  it("generateHires posts offers at stations over time, capped per-station", () => {
    const w = createWorld();
    unlockAllMilestonesForTests(w);
    tickN(w, 200);
    const havenOffers = listHiresAt(w, "haven");
    expect(havenOffers.length).toBeGreaterThan(0);
    expect(havenOffers.length).toBeLessThanOrEqual(6);
    for (const h of havenOffers) {
      expect(h.location).toBe("haven");
      expect(h.expiresAt).toBeGreaterThan(w.tick - 1);
    }
  });

  it("offers expire on schedule", () => {
    const w = createWorld();
    const offer = postTestHire(w, "haven", "captain", { expiresAt: w.tick + 5 });
    expect(w.hires[offer.id]).toBeDefined();
    tickN(w, 6);
    expect(w.hires[offer.id]).toBeUndefined();
  });

  it("generated hires have small modifiers (or none) and sane costs", () => {
    const w = createWorld();
    unlockAllMilestonesForTests(w);
    tickN(w, 400);
    const all = Object.values(w.hires);
    expect(all.length).toBeGreaterThan(0);
    const integerMods = new Set(["cargoCapacityBonus", "fuelCapacityBonus", "speedBonus"]);
    const flatRateMods = new Set(["fuelRegenIdle"]);
    for (const h of all) {
      expect(h.hireCost).toBeGreaterThan(0);
      expect(h.wagePerTick).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(h.modifiers) as [string, number][]) {
        if (integerMods.has(k)) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(10);
        } else if (flatRateMods.has(k)) {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(1);
        } else {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(0.15);
        }
      }
    }
  });

  it("generated navigators have a reasonable T1 base price", () => {
    const w = createWorld();
    unlockAllMilestonesForTests(w);
    const navigators = [];
    for (let i = 0; i < 1_200; i++) {
      navigators.push(...tickWorld(w).hiresPosted.filter(h => h.role === "navigator"));
    }

    const tierOne = navigators.filter(h => h.tier === 1);
    expect(tierOne.length).toBeGreaterThan(0);
    // T1 navigator base is now Ç45k (action milestone is the gate, not price).
    // Cap is loose so trait-bearing variants still pass.
    expect(Math.min(...tierOne.map(h => h.hireCost))).toBeLessThanOrEqual(60_000);

    const tierTwo = navigators.filter(h => h.tier === 2);
    if (tierTwo.length > 0) {
      expect(Math.max(...tierTwo.map(h => h.hireCost))).toBeLessThanOrEqual(150_000);
    }
  });

  it("generated pilots stay a meaningful expense", () => {
    const w = createWorld();
    unlockAllMilestonesForTests(w);
    const pilots = [];
    for (let i = 0; i < 1_200; i++) {
      pilots.push(...tickWorld(w).hiresPosted.filter(h => h.role === "captain"));
    }

    const tierOne = pilots.filter(h => h.tier === 1);
    expect(tierOne.length).toBeGreaterThan(0);
    // T1 captain base is now Ç90k (action gate handles autopilot pacing).
    expect(Math.min(...tierOne.map(h => h.hireCost))).toBeGreaterThanOrEqual(80_000);
  });

  it("generation is deterministic for the same starting state", () => {
    const a = createWorld();
    const b = createWorld();
    tickN(a, 80);
    tickN(b, 80);
    expect(Object.keys(a.hires).sort()).toEqual(Object.keys(b.hires).sort());
  });
});

// silence unused-import warning when the test file doesn't trigger generation directly
void generateHires;
