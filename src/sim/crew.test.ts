import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN } from "./tick";
import {
  fireCrew, hireCrew, MAINTENANCE_DEBT_TRAVEL_BLOCK, recomputeShipStats, totalCrewWage,
} from "./crew";
import { repairShip, travelTo } from "./traders";
import { generateJobs } from "./jobs";
import { generateHires, listHiresAt } from "./hires";
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
    w.player!.funds = 1_000_000;
    const ship = getPlayerShip(w);
    recomputeShipStats(ship);
    const baseFuel = ship.fuelCapacity;
    const fundsBefore = w.player!.funds;
    const offer = postTestHire(w, ship.location, "navigator", { hireCost: 240_000, modifiers: { fuelCapacityBonus: 8 } });
    expect(hireCrew(w, ship, offer.id).ok).toBe(true);
    expect(ship.crew?.navigator?.id).toBe(offer.id);
    expect(w.player!.funds).toBe(fundsBefore - 240_000);
    expect(ship.fuelCapacity).toBe(baseFuel + 8);
    expect(w.hires[offer.id]).toBeUndefined();        // offer consumed
  });

  it("hireCrew rejects when can't afford", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    w.player!.funds = 100;
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
    w.player!.funds = 100_000;
    const offer = postTestHire(w, "verdant", "captain", { hireCost: 25_000 });
    expect(ship.location).not.toBe("verdant");
    const r = hireCrew(w, ship, offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("different station");
  });

  it("fireCrew clears slot and reverts stats", () => {
    const w = createWorld();
    w.player!.funds = 1_000_000;
    const ship = getPlayerShip(w);
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
    w.player!.funds = 1_000_000;
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
  it("auto-pilot does NOT trade without a captain (silent idle)", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.pilot = "auto";
    const fundsBefore = w.player!.funds;
    tickN(w, 50);
    const traded = ship.log.some(e => e.kind === "buy" || e.kind === "sell");
    expect(traded).toBe(false);
    expect(w.player!.funds).toBeLessThanOrEqual(fundsBefore);
  });

  it("auto-pilot WITH captain trades, but does NOT auto-accept contracts (no navigator)", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    w.player!.funds = 1_000_000;
    const cap = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    expect(hireCrew(w, ship, cap.id).ok).toBe(true);
    ship.pilot = "auto";
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    tickN(w, 200);
    const accepted = ship.log.filter(e => e.kind === "job_accepted").length;
    expect(accepted).toBe(0);
  });

  it("auto-pilot WITH captain + navigator accepts contracts on arrival", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    w.player!.funds = 5_000_000;
    const cap = postTestHire(w, ship.location, "captain", { hireCost: 25_000 });
    const nav = postTestHire(w, ship.location, "navigator", { hireCost: 240_000 });
    expect(hireCrew(w, ship, cap.id).ok).toBe(true);
    expect(hireCrew(w, ship, nav.id).ok).toBe(true);
    ship.pilot = "auto";
    tickN(w, 300);
    const accepted = ship.log.filter(e => e.kind === "job_accepted").length;
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("crew: maintenance debt + repair", () => {
  it("debt accumulates without a mechanic", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    w.player!.funds = 1_000_000;
    const cap = postTestHire(w, ship.location, "captain");
    hireCrew(w, ship, cap.id);
    ship.pilot = "auto";
    tickN(w, 50);
    expect(ship.maintenanceDebt ?? 0).toBeGreaterThan(0);
  });

  it("debt does NOT accumulate with a mechanic", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    w.player!.funds = 1_000_000;
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

  it("repairShip pays debt from player funds and clears it", () => {
    const w = createWorld();
    const ship = getPlayerShip(w);
    ship.maintenanceDebt = 1000;
    const fundsBefore = w.player!.funds;
    const r = repairShip(w, ship);
    expect(r.ok).toBe(true);
    expect(ship.maintenanceDebt).toBe(0);
    expect(w.player!.funds).toBe(fundsBefore - 1000);
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
    w.player!.funds = 500_000;
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
    tickN(w, 400);
    const all = Object.values(w.hires);
    expect(all.length).toBeGreaterThan(0);
    const integerMods = new Set(["cargoCapacityBonus", "fuelCapacityBonus", "speedBonus"]);
    for (const h of all) {
      expect(h.hireCost).toBeGreaterThan(0);
      expect(h.wagePerTick).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(h.modifiers) as [string, number][]) {
        if (integerMods.has(k)) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(10);
        } else {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(0.15);
        }
      }
    }
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
