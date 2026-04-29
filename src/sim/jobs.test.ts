import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickN, tickWorld } from "./tick";
import {
  abandonJob, acceptJob, creditJobOnDelivery, expireJobs, generateJobs,
  listAvailableRescueJobs, listLocalJobs, listLocalShortageJobs, listVisibleAvailableJobs,
  EXPIRY_TICKS_BY_TIER, MAX_OPEN_JOBS, PENALTY_FRACTION_BY_TIER, REWARD_MULT_BY_TIER,
  maxOpenJobs,
} from "./jobs";
import { sellAtLocation, UNLOAD_TICKS } from "./traders";
import { generateWorld } from "./gen/world";

describe("jobs: shortage generation", () => {
  it("posts a shortage job when a market is far below target on a consumed good", () => {
    const w = createWorld();
    // Crash haven's grain stock below the 5% high-tier threshold
    w.markets.haven.stock.grain = 0;
    const posted = generateJobs(w);
    const grainJob = posted.find(j => j.kind === "shortage" && j.destination === "haven" && j.good === "grain");
    expect(grainJob).toBeDefined();
    expect(grainJob!.tier).toBe("high");
    expect(grainJob!.qty).toBeGreaterThan(0);
    expect(grainJob!.reward).toBeGreaterThan(0);
    expect(grainJob!.penalty).toBe(Math.round(grainJob!.reward * PENALTY_FRACTION_BY_TIER.high));
  });

  it("does NOT post when stock is healthy", () => {
    const w = createWorld();
    // Make every consumed good well-stocked
    for (const loc of Object.values(w.locations)) {
      for (const c of loc.consumes) {
        const target = loc.targetStock[c.good] ?? 0;
        if (target > 0) w.markets[loc.id].stock[c.good] = target;
      }
    }
    const posted = generateJobs(w);
    expect(posted.filter(j => j.kind === "shortage").length).toBe(0);
  });

  it("tier scales with severity", () => {
    const w = createWorld();
    const target = w.locations.haven.targetStock.grain ?? 80;
    w.markets.haven.stock.grain = target * 0.30; // low band
    let posted = generateJobs(w);
    let job = posted.find(j => j.destination === "haven" && j.good === "grain");
    expect(job?.tier).toBe("low");

    // Reset board, drop further
    w.jobs = {};
    w.markets.haven.stock.grain = target * 0.10; // medium band (< 0.20)
    posted = generateJobs(w);
    job = posted.find(j => j.destination === "haven" && j.good === "grain");
    expect(job?.tier).toBe("medium");

    w.jobs = {};
    w.markets.haven.stock.grain = target * 0.02; // high band
    posted = generateJobs(w);
    job = posted.find(j => j.destination === "haven" && j.good === "grain");
    expect(job?.tier).toBe("high");
  });

  it("does not post duplicate jobs for the same (destination, good, kind)", () => {
    const w = createWorld();
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const before = Object.keys(w.jobs).length;
    generateJobs(w);
    expect(Object.keys(w.jobs).length).toBe(before);
  });
});

describe("jobs: rescue generation", () => {
  it("posts a rescue when an NPC has been stuck for at least one tick", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc");
    expect(npc).toBeDefined();
    if (!npc) return;
    // Strand it: zero fuel, isolated by virtue of having no fuel for any hop.
    npc.currentFuel = { good: "plasma", qty: 0 };
    npc.state = "idle";
    npc.stuckTicks = 1;
    const posted = generateJobs(w);
    const rescue = posted.find(j => j.kind === "rescue" && j.rescueTarget === npc.id);
    expect(rescue).toBeDefined();
    expect(rescue!.destination).toBe(npc.location);
    expect(rescue!.good).toBe("plasma");
  });

  it("rescue tier escalates with stuck duration", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc");
    if (!npc) return;
    npc.stuckTicks = 1;
    let posted = generateJobs(w);
    expect(posted.find(j => j.kind === "rescue")?.tier).toBe("low");

    w.jobs = {};
    npc.stuckTicks = 5;
    posted = generateJobs(w);
    expect(posted.find(j => j.kind === "rescue")?.tier).toBe("medium");

    w.jobs = {};
    npc.stuckTicks = 12;
    posted = generateJobs(w);
    expect(posted.find(j => j.kind === "rescue")?.tier).toBe("high");
  });

  it("does not post a rescue for the player's own ship", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.currentFuel = { good: "plasma", qty: 0 };
    ship.stuckTicks = 5;
    const posted = generateJobs(w);
    expect(posted.find(j => j.kind === "rescue" && j.rescueTarget === ship.id)).toBeUndefined();
  });
});

describe("jobs: caps + expiry", () => {
  it("respects the open job cap", () => {
    const w = createWorld();
    // Crash all consumed-good stocks to force many shortage jobs
    for (const loc of Object.values(w.locations)) {
      for (const c of loc.consumes) {
        w.markets[loc.id].stock[c.good] = 0;
      }
    }
    generateJobs(w);
    expect(Object.keys(w.jobs).length).toBeLessThanOrEqual(maxOpenJobs(w));
  });

  it("scales the open job cap with station count", () => {
    const small = createWorld();
    const large = generateWorld({ seed: 20260427, locationCount: 48, traderCount: 0, player: null });
    expect(maxOpenJobs(small)).toBe(MAX_OPEN_JOBS);
    expect(maxOpenJobs(large)).toBeGreaterThan(MAX_OPEN_JOBS);
    expect(maxOpenJobs(large)).toBe(72);
  });

  it("does not let shortage pressure crowd out rescue contracts", () => {
    const w = generateWorld({ seed: 20260427, locationCount: 48, traderCount: 12, player: null });
    const locations = Object.keys(w.locations);
    for (const loc of Object.values(w.locations)) {
      for (const c of loc.consumes) {
        w.markets[loc.id].stock[c.good] = 0;
      }
    }
    Object.values(w.traders).slice(0, 8).forEach((trader, index) => {
      trader.location = locations[index % locations.length];
      trader.currentFuel = { good: trader.fuelTypes[0]?.good ?? "plasma", qty: 0 };
      trader.stuckTicks = 12;
    });

    generateJobs(w);
    expect(Object.values(w.jobs).some(j => j.kind === "rescue")).toBe(true);
    expect(Object.keys(w.jobs).length).toBeLessThanOrEqual(maxOpenJobs(w));
  });

  it("expireJobs removes expired entries", () => {
    const w = createWorld();
    w.markets.haven.stock.grain = 0;
    const posted = generateJobs(w);
    const job = posted[0];
    expect(job).toBeDefined();
    w.tick = job.expiresAt;
    expireJobs(w);
    expect(w.jobs[job.id]).toBeUndefined();
  });

  it("expiring an accepted high-tier job charges the ship penalty", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000;
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const job = Object.values(w.jobs).find(j => j.tier === "high")!;
    expect(job).toBeDefined();
    acceptJob(w, job.id, ship.id);
    const fundsBefore = ship.funds;
    w.tick = job.expiresAt;
    const events = expireJobs(w);
    expect(events.find(e => e.jobId === job.id)?.penalty).toBe(job.penalty);
    expect(ship.funds).toBe(fundsBefore - job.penalty);
  });

  it("expiring a low-tier accepted job applies no penalty", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const target = w.locations.haven.targetStock.grain ?? 80;
    w.markets.haven.stock.grain = target * 0.30; // low
    generateJobs(w);
    const job = Object.values(w.jobs).find(j => j.tier === "low")!;
    expect(job).toBeDefined();
    expect(job.penalty).toBe(0);
    acceptJob(w, job.id, ship.id);
    const fundsBefore = ship.funds;
    w.tick = job.expiresAt;
    expireJobs(w);
    expect(ship.funds).toBe(fundsBefore);
  });
});

describe("jobs: accept / abandon / completion", () => {
  it("acceptJob marks acceptedBy + abandonJob clears it (with penalty for medium+)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 100_000;
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const job = Object.values(w.jobs).find(j => j.tier === "high")!;
    expect(acceptJob(w, job.id, ship.id).ok).toBe(true);
    expect(w.jobs[job.id].acceptedBy).toBe(ship.id);
    const fundsBefore = ship.funds;
    abandonJob(w, job.id);
    expect(w.jobs[job.id]).toBeUndefined();
    expect(ship.funds).toBe(fundsBefore - job.penalty);
  });

  it("abandoning an unaccepted job is free", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const job = Object.values(w.jobs)[0];
    const fundsBefore = ship.funds;
    abandonJob(w, job.id);
    expect(ship.funds).toBe(fundsBefore);
  });

  it("creditJobOnDelivery pays out reward to the ship when the delivered qty meets the contract", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const jobId = "j-test";
    w.jobs[jobId] = {
      id: jobId, kind: "shortage", tier: "medium", good: "grain", qty: 5,
      destination: ship.location, reward: 1000, penalty: 250, postedTick: 0,
      expiresAt: 999, acceptedBy: ship.id, delivered: 0,
    };
    const fundsBefore = ship.funds;
    const events = creditJobOnDelivery(w, ship.id, ship.location, "grain", 5);
    expect(events).toHaveLength(1);
    expect(events[0].partial).toBe(false);
    expect(events[0].reward).toBe(1000);
    expect(ship.funds).toBe(fundsBefore + 1000);
    expect(w.jobs[jobId]).toBeUndefined();
  });

  it("creditJobOnDelivery records partial progress until full delivery", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    const jobId = "j-test";
    w.jobs[jobId] = {
      id: jobId, kind: "shortage", tier: "low", good: "grain", qty: 10,
      destination: ship.location, reward: 500, penalty: 0, postedTick: 0,
      expiresAt: 999, acceptedBy: ship.id, delivered: 0,
    };
    const fundsBefore = ship.funds;
    let evs = creditJobOnDelivery(w, ship.id, ship.location, "grain", 4);
    expect(evs[0].partial).toBe(true);
    expect(evs[0].delivered).toBe(4);
    expect(ship.funds).toBe(fundsBefore);

    evs = creditJobOnDelivery(w, ship.id, ship.location, "grain", 6);
    expect(evs[0].partial).toBe(false);
    expect(ship.funds).toBe(fundsBefore + 500);
  });

  it("sellAtLocation triggers job credit + reward after the drip completes", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.cargo = [{ good: "grain", qty: 8, source: "verdant", unitPrice: 5, purchasedAt: 0 }];
    w.markets[ship.location].stock.grain = 0;
    const jobId = "j-test";
    w.jobs[jobId] = {
      id: jobId, kind: "shortage", tier: "medium", good: "grain", qty: 8,
      destination: ship.location, reward: 800, penalty: 200, postedTick: 0,
      expiresAt: 999, acceptedBy: ship.id, delivered: 0,
    };
    const fundsBefore = ship.funds;
    const r = sellAtLocation(w, ship, "grain");
    expect(r.ok).toBe(true);

    // Sell now drips: cargo moves to unloadingCargo, settles 1/N per tick.
    // After UNLOAD_TICKS the job is fully credited and the reward paid.
    tickN(w, UNLOAD_TICKS);
    expect(ship.unloadingCargo ?? []).toEqual([]);
    expect(w.jobs[jobId]).toBeUndefined();
    // Ship gets sale revenue + reward bonus.
    expect(ship.funds).toBeGreaterThan(fundsBefore + 800);
  });
});

describe("jobs: visibility (location-gated shortages, broadcast rescues)", () => {
  it("listLocalShortageJobs returns only shortages at the given station", () => {
    const w = createWorld();
    w.markets.haven.stock.grain = 0;
    w.markets.ironhold.stock.protein = 0; // posting candidate at ironhold if applicable
    generateJobs(w);
    const havenLocal = listLocalShortageJobs(w, "haven");
    for (const j of havenLocal) {
      expect(j.kind).toBe("shortage");
      expect(j.destination).toBe("haven");
      expect(j.acceptedBy).toBeNull();
    }
    // verdant shouldn't surface haven's grain shortage
    const verdantLocal = listLocalShortageJobs(w, "verdant");
    expect(verdantLocal.find(j => j.destination === "haven")).toBeUndefined();
  });

  it("listLocalShortageJobs excludes accepted jobs", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const before = listLocalShortageJobs(w, "haven");
    expect(before.length).toBeGreaterThan(0);
    acceptJob(w, before[0].id, ship.id);
    const after = listLocalShortageJobs(w, "haven");
    expect(after.find(j => j.id === before[0].id)).toBeUndefined();
  });

  it("listLocalJobs returns shortages AND co-located rescues, but not remote rescues", () => {
    const w = createWorld();
    // Stranded NPC at haven (player's start)
    const npc = Object.values(w.traders).find(t => t.pilot === "npc")!;
    npc.location = "haven";
    npc.stuckTicks = 3;
    // Shortage at haven
    w.markets.haven.stock.grain = 0;
    // Stranded NPC at a different station
    const remote = Object.values(w.traders).filter(t => t.pilot === "npc")[1];
    if (remote) {
      remote.location = "verdant";
      remote.stuckTicks = 3;
    }
    generateJobs(w);
    const local = listLocalJobs(w, "haven");
    const kinds = local.map(j => j.kind);
    expect(kinds).toContain("shortage");
    expect(kinds).toContain("rescue");
    // No verdant rescue should leak in
    expect(local.find(j => j.destination === "verdant")).toBeUndefined();
  });

  it("listAvailableRescueJobs is global — independent of location", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc")!;
    npc.stuckTicks = 5;
    generateJobs(w);
    const rescues = listAvailableRescueJobs(w);
    expect(rescues.length).toBeGreaterThan(0);
    for (const j of rescues) expect(j.kind).toBe("rescue");
  });

  it("listVisibleAvailableJobs combines local shortages + all rescues, hides remote shortages", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc")!;
    npc.stuckTicks = 3;
    w.markets.haven.stock.grain = 0;       // shortage at haven
    w.markets.verdant.stock.protein = 0;   // shortage at verdant (probably — depends on consumes)
    generateJobs(w);

    const visibleAtHaven = listVisibleAvailableJobs(w, "haven");
    const remoteShortageAtVerdant = visibleAtHaven.find(
      j => j.kind === "shortage" && j.destination !== "haven",
    );
    expect(remoteShortageAtVerdant).toBeUndefined();
    // rescues should still be in the visible list regardless of station
    const hasRescue = visibleAtHaven.some(j => j.kind === "rescue");
    expect(hasRescue).toBe(true);
  });

  it("listVisibleAvailableJobs with null location returns rescues only (in-transit case)", () => {
    const w = createWorld();
    const npc = Object.values(w.traders).find(t => t.pilot === "npc")!;
    npc.stuckTicks = 3;
    w.markets.haven.stock.grain = 0;
    generateJobs(w);
    const visible = listVisibleAvailableJobs(w, null);
    for (const j of visible) expect(j.kind).toBe("rescue");
  });
});

describe("jobs: integration via tickWorld", () => {
  it("tick generates + expires jobs over time", () => {
    const w = createWorld();
    // Crash a stock to guarantee shortage
    w.markets.haven.stock.grain = 0;
    const reports = tickN(w, 5);
    const totalPosted = reports.reduce((s, r) => s + r.jobsPosted.length, 0);
    expect(totalPosted).toBeGreaterThan(0);
  });

  it("constants line up: REWARD_MULT_BY_TIER + EXPIRY_TICKS_BY_TIER are sensible", () => {
    expect(REWARD_MULT_BY_TIER.high).toBeGreaterThan(REWARD_MULT_BY_TIER.medium);
    expect(REWARD_MULT_BY_TIER.medium).toBeGreaterThan(REWARD_MULT_BY_TIER.low);
    expect(EXPIRY_TICKS_BY_TIER.low).toBeGreaterThan(EXPIRY_TICKS_BY_TIER.high);
    expect(PENALTY_FRACTION_BY_TIER.low).toBe(0);
  });

  // Reference tickWorld so unused-import linters stay happy
  it.skip("tickWorld reference", () => { tickWorld(createWorld()); });
});
