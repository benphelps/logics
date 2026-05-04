import { describe, expect, it } from "vitest";
import { createWorld } from "../world";
import { tickN } from "../tick";
import {
  autopilotPolicy,
  ENCOUNTER_COOLDOWN_TICKS,
  encounterChance,
  MAX_ENCOUNTER_CHANCE,
  MIN_ENCOUNTER_CHANCE,
  maybeSpawnEncounter,
  recordEncounter,
  resolveEncounter,
  resolvePendingEncounter,
  selectCargoLossLightFirst,
} from "./encounters";
import type { Encounter, EncounterAttacker, Good, GoodId, Trader, World } from "../types";

// --- helpers -------------------------------------------------------------

function freshWorld(): World {
  return createWorld();
}

function playerShip(world: World): Trader {
  const id = world.player!.shipIds[0];
  return world.traders[id];
}

function fakeAttacker(overrides: Partial<EncounterAttacker> = {}): EncounterAttacker {
  return {
    name: "Test Skiff",
    kind: "pirate",
    weaponPower: 10,
    hull: 30,
    speed: 8,
    crewLevel: 0.5,
    ...overrides,
  };
}

function fakeEncounter(world: World, ship: Trader, overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: "enc-test",
    spawnedAt: world.tick,
    shipId: ship.id,
    fromLocation: ship.location,
    toLocation: ship.destination ?? ship.location,
    attacker: fakeAttacker(),
    pFight: 0.7,
    pFlee: 0.7,
    pNegotiate: 0.7,
    oddsFight: "likely",
    oddsFlee: "likely",
    oddsNegotiate: "likely",
    fightLossOnFail: { credits: 1000, cargo: [], hull: 5 },
    fleeLossOnFail: { credits: 0, cargo: [], hull: 3 },
    negotiateBribe: 1500,
    negotiatePartialCargo: [],
    ...overrides,
  };
}

function makeGood(id: GoodId, weight: number, basePrice: number): Good {
  return { id, name: id, category: "raw", basePrice, weight };
}

// --- selectCargoLossLightFirst ------------------------------------------

describe("selectCargoLossLightFirst", () => {
  it("prefers lighter goods first", () => {
    const w = freshWorld();
    w.goods = {
      light: makeGood("light", 1, 100),
      heavy: makeGood("heavy", 10, 50),
    };
    const ship = playerShip(w);
    ship.cargo = [
      { good: "heavy", qty: 5, source: "x", unitPrice: 50, purchasedAt: 0 },
      { good: "light", qty: 5, source: "x", unitPrice: 100, purchasedAt: 0 },
    ];
    // Total mass = 5*1 + 5*10 = 55. Take 6 mass → all 5 light (5 mass) + 1 heavy (10 mass)?
    // Actually 5 mass < 6 mass, so all light first → remaining 1 mass → 0 heavy (qty floor).
    const picked = selectCargoLossLightFirst(ship, w, 6);
    expect(picked.find(p => p.good === "light")?.qty).toBe(5);
    // 1 mass remaining can't afford a heavy unit (weight 10), so floored to nothing.
    expect(picked.find(p => p.good === "heavy")).toBeUndefined();
  });

  it("returns empty for zero target mass", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    expect(selectCargoLossLightFirst(ship, w, 0)).toEqual([]);
  });

  it("merges duplicate goods across lots", () => {
    const w = freshWorld();
    w.goods = { x: makeGood("x", 1, 1) };
    const ship = playerShip(w);
    ship.cargo = [
      { good: "x", qty: 3, source: "a", unitPrice: 1, purchasedAt: 0 },
      { good: "x", qty: 4, source: "b", unitPrice: 1, purchasedAt: 0 },
    ];
    const picked = selectCargoLossLightFirst(ship, w, 100);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toEqual({ good: "x", qty: 7 });
  });
});

// --- resolveEncounter ----------------------------------------------------

describe("resolveEncounter", () => {
  it("fight win applies no loss", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    const before = { funds: ship.funds, hull: ship.hull, cargoLen: ship.cargo.length };
    const enc = fakeEncounter(w, ship, { pFight: 1.0 });
    const outcome = resolveEncounter(w, ship, enc, "fight", false);
    expect(outcome).toBe("won");
    expect(ship.funds).toBe(before.funds);
    expect(ship.hull).toBe(before.hull);
    expect(ship.cargo.length).toBe(before.cargoLen);
    expect(enc.resolution).toBeDefined();
    expect(enc.resolution?.autoResolved).toBe(false);
  });

  it("fight loss applies cargo, credits, and hull damage", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.funds = 5000;
    ship.hull = 50;
    ship.cargo = [{ good: "grain", qty: 10, source: "x", unitPrice: 5, purchasedAt: 0 }];
    const enc = fakeEncounter(w, ship, {
      pFight: 0,
      fightLossOnFail: {
        credits: 1000,
        cargo: [{ good: "grain", qty: 4 }],
        hull: 8,
      },
    });
    const outcome = resolveEncounter(w, ship, enc, "fight", false);
    expect(outcome).toBe("lost");
    expect(ship.funds).toBe(4000);
    expect(ship.hull).toBe(42);
    expect(ship.cargo[0].qty).toBe(6);
  });

  it("flee fail damages hull only", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    const startFunds = ship.funds;
    const startCargoLen = ship.cargo.length;
    const enc = fakeEncounter(w, ship, {
      pFlee: 0,
      fleeLossOnFail: { credits: 0, cargo: [], hull: 3 },
    });
    const startHull = ship.hull ?? 0;
    const outcome = resolveEncounter(w, ship, enc, "flee", false);
    expect(outcome).toBe("fled_damaged");
    expect(ship.hull).toBe(startHull - 3);
    expect(ship.funds).toBe(startFunds);
    expect(ship.cargo.length).toBe(startCargoLen);
  });

  it("negotiate peace with rival deducts bribe and grants no other loss", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.funds = 10_000;
    const startHull = ship.hull;
    const enc = fakeEncounter(w, ship, {
      pNegotiate: 1.0,
      negotiateBribe: 2000,
      attacker: fakeAttacker({ kind: "rival_syndicate", syndicateId: "Syn-A" }),
    });
    const outcome = resolveEncounter(w, ship, enc, "negotiate", false);
    expect(outcome).toBe("negotiated_peace");
    expect(ship.funds).toBe(8000);
    expect(ship.hull).toBe(startHull);
  });

  it("negotiate succeeds with pirate but takes partial cargo", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.funds = 10_000;
    ship.cargo = [{ good: "grain", qty: 10, source: "x", unitPrice: 5, purchasedAt: 0 }];
    const enc = fakeEncounter(w, ship, {
      pNegotiate: 1.0,
      negotiateBribe: 500,
      negotiatePartialCargo: [{ good: "grain", qty: 3 }],
      attacker: fakeAttacker({ kind: "pirate" }),
    });
    const outcome = resolveEncounter(w, ship, enc, "negotiate", false);
    expect(outcome).toBe("negotiated_partial");
    expect(ship.funds).toBe(9500);
    expect(ship.cargo[0].qty).toBe(7);
  });

  it("negotiate without funds falls through to fight loss", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.funds = 100; // less than bribe
    ship.hull = 50;
    const enc = fakeEncounter(w, ship, {
      negotiateBribe: 2000,
      fightLossOnFail: { credits: 50, cargo: [], hull: 6 },
    });
    const outcome = resolveEncounter(w, ship, enc, "negotiate", false);
    expect(outcome).toBe("negotiated_fail");
    // Took the fight loss (capped at funds).
    expect(ship.funds).toBe(50);
    expect(ship.hull).toBe(44);
  });

  it("rival fight reduces reputation; rival peace increases it", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.funds = 10_000;
    w.player!.reputation = { "Syn-A": 0.5 };
    const peaceEnc = fakeEncounter(w, ship, {
      pNegotiate: 1.0,
      attacker: fakeAttacker({ kind: "rival_syndicate", syndicateId: "Syn-A" }),
    });
    resolveEncounter(w, ship, peaceEnc, "negotiate", false);
    expect(w.player!.reputation!["Syn-A"]).toBeGreaterThan(0.5);

    const fightEnc = fakeEncounter(w, ship, {
      pFight: 1.0,
      attacker: fakeAttacker({ kind: "rival_syndicate", syndicateId: "Syn-A" }),
    });
    const beforeFight = w.player!.reputation!["Syn-A"];
    resolveEncounter(w, ship, fightEnc, "fight", false);
    expect(w.player!.reputation!["Syn-A"]).toBeLessThan(beforeFight);
  });
});

// --- autopilotPolicy ----------------------------------------------------

describe("autopilotPolicy", () => {
  it("flees by default without a mercenary", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.crew = {};
    const enc = fakeEncounter(w, ship, { pFight: 0.9, pFlee: 0.5, pNegotiate: 0.2 });
    expect(autopilotPolicy(ship, enc)).toBe("flee");
  });

  it("fights with a mercenary when fight odds are good", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.crew = {
      mercenary: {
        id: "m", role: "mercenary", name: "Merc", tier: 2,
        hireCost: 0, wagePerTick: 0, modifiers: {},
        sex: "female", age: "adult", race: "human",
      },
    };
    const enc = fakeEncounter(w, ship, { pFight: 0.7, pFlee: 0.3, pNegotiate: 0.2 });
    expect(autopilotPolicy(ship, enc)).toBe("fight");
  });

  it("negotiates when affordable and odds are good and no merc", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.crew = {};
    ship.funds = 10_000;
    const enc = fakeEncounter(w, ship, {
      pFight: 0.2, pFlee: 0.2, pNegotiate: 0.7, negotiateBribe: 1000,
    });
    expect(autopilotPolicy(ship, enc)).toBe("negotiate");
  });
});

// --- encounterChance -----------------------------------------------------

describe("encounterChance", () => {
  it("clamps to [MIN, MAX]", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    // Ensure ship has a destination.
    ship.state = "transit";
    ship.destination = w.player!.shipIds[0] === ship.id
      ? Object.keys(w.locations).find(l => l !== ship.location)!
      : ship.location;
    const p = encounterChance(w, ship);
    expect(p).toBeGreaterThanOrEqual(MIN_ENCOUNTER_CHANCE);
    expect(p).toBeLessThanOrEqual(MAX_ENCOUNTER_CHANCE);
  });

  it("returns 0 for ship with no destination", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.destination = null;
    expect(encounterChance(w, ship)).toBe(0);
  });
});

// --- maybeSpawnEncounter cooldown ---------------------------------------

describe("maybeSpawnEncounter cooldown", () => {
  it("returns null while ship is in cooldown window", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.state = "transit";
    ship.destination = Object.keys(w.locations).find(l => l !== ship.location)!;
    ship.lastEncounterTick = w.tick;
    // Within cooldown window — never spawns.
    for (let i = 0; i < ENCOUNTER_COOLDOWN_TICKS - 1; i++) {
      expect(maybeSpawnEncounter(w, ship)).toBeNull();
      w.tick += 1;
    }
  });

  it("returns null when ship not in transit", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.state = "idle";
    expect(maybeSpawnEncounter(w, ship)).toBeNull();
  });
});

// --- resolvePendingEncounter --------------------------------------------

describe("resolvePendingEncounter", () => {
  it("clears pendingEncounter and pushes to history", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    const enc = fakeEncounter(w, ship, { pFight: 1.0 });
    w.pendingEncounter = enc;
    const out = resolvePendingEncounter(w, "fight");
    expect(out).toBe(enc);
    expect(out?.resolution?.outcome).toBe("won");
    expect(out?.resolution?.autoResolved).toBe(false);
    expect(w.pendingEncounter).toBeUndefined();
    expect(w.encounterHistory?.length).toBe(1);
  });

  it("returns null when there is no pending encounter", () => {
    const w = freshWorld();
    expect(resolvePendingEncounter(w, "fight")).toBeNull();
  });
});

// --- recordEncounter ----------------------------------------------------

describe("recordEncounter", () => {
  it("caps history length", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    for (let i = 0; i < 250; i++) {
      const enc = fakeEncounter(w, ship, { id: `enc-${i}` });
      enc.resolution = {
        choice: "flee", outcome: "escaped", tick: w.tick, autoResolved: true,
      };
      recordEncounter(w, enc);
    }
    expect(w.encounterHistory!.length).toBe(200);
    // Oldest entries should have rolled off the front.
    expect(w.encounterHistory![0].id).toBe("enc-50");
  });
});

// --- integration through tick -------------------------------------------

describe("encounter integration", () => {
  it("does not advance ticksRemaining while pendingEncounter is set", () => {
    const w = freshWorld();
    const ship = playerShip(w);
    ship.pilot = "manual";
    ship.state = "transit";
    ship.ticksRemaining = 5;
    ship.destination = Object.keys(w.locations).find(l => l !== ship.location)!;
    // Plant a pending encounter on this ship.
    w.pendingEncounter = fakeEncounter(w, ship);
    tickN(w, 1);
    expect(ship.ticksRemaining).toBe(5);
  });

  it("auto-resolves and writes to encounterHistory when an encounter fires under autopilot", () => {
    // Force a high-probability encounter situation by maxing cargo value, then
    // run many ticks to ensure at least one fires deterministically. This is
    // an integration smoke test rather than a unit assertion of the trigger.
    const w = freshWorld();
    const ship = playerShip(w);
    ship.pilot = "auto";
    ship.crew = {
      captain: {
        id: "c", role: "captain", name: "Captain", tier: 1,
        hireCost: 0, wagePerTick: 0, modifiers: {},
        sex: "female", age: "adult", race: "human",
      },
    };
    // Run enough ticks that the autopilot picks a destination naturally and
    // some encounter rolls land.
    tickN(w, 200);
    // No assertion about an encounter firing — the trigger is probabilistic.
    // We just want to make sure the integration doesn't crash and that any
    // encounters that fired were recorded properly (resolution stamped).
    for (const enc of w.encounterHistory ?? []) {
      expect(enc.resolution).toBeDefined();
      expect(enc.resolution?.autoResolved).toBe(true);
    }
  });
});
