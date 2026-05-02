import { describe, it, expect } from "vitest";
import { createStartingWorld } from "./start";
import { tickN } from "./tick";
import {
  bumpPlayerReputation,
  effectiveToll,
  FOREIGN_DOCK_TOLL,
  isOwnTerritory,
  nudgeStationControl,
  NPC_TRADE_PER_CREDIT,
  OWN_TERRITORY_BUY_BONUS,
  OWN_TERRITORY_SELL_BONUS,
  playerReputationWith,
  PLAYER_TRADE_PER_CREDIT,
  territoryBuyBonus,
  territorySellBonus,
  tickControl,
  tollForArrival,
} from "./control";
import type { LocationId, SyndicateId, World } from "./types";

// Long-horizon tests for the syndicate territory system. These exercise
// the per-tick control nudges + decay over hundreds of ticks to surface
// balance regressions early — runaway dominance, silent syndicate
// wipeouts, conservation drift, faction stamps that fall out of sync.
//
// Uses a smaller world (20 stations / 40 traders) so the tick loop
// stays cheap; the underlying control mechanics are agnostic to world
// size and any pathology that would show up at 50 stations shows up
// here too. Bump TICKS_LONG locally if you want a stress run before
// landing parameter changes.

const TICKS_LONG = 400;
const TICKS_MEDIUM = 80;
const SEEDS = [3, 17, 137];
const TEST_TIMEOUT_MS = 30_000;

function freshWorld(seed: number): World {
  // ageTicks: 0 starts at the gen-time control snapshot (every station
  // 100% to its owner) so the test's tick count alone drives the state
  // transitions we're measuring. Smaller world keeps per-tick cost
  // bounded.
  return createStartingWorld({ seed, ageTicks: 0, locationCount: 20, traderCount: 40 });
}

// Same minimal world but with the player ship stamped to a specific
// syndicate, so tests that need an own-territory / foreign-territory
// distinction can find both around the player ship.
function affiliatedWorld(seed: number, syndicateId: SyndicateId = "syn_1"): World {
  return createStartingWorld({ seed, ageTicks: 0, locationCount: 20, traderCount: 40, syndicateId });
}

function factionStationCounts(world: World): Map<SyndicateId, number> {
  const counts = new Map<SyndicateId, number>();
  for (const loc of Object.values(world.locations)) {
    const f = loc.traits.faction;
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

function totalShareBySyndicate(world: World): Map<SyndicateId, number> {
  const totals = new Map<SyndicateId, number>();
  if (!world.control) return totals;
  for (const m of Object.values(world.control)) {
    for (const k in m) totals.set(k, (totals.get(k) ?? 0) + m[k]);
  }
  return totals;
}

describe("syndicate control invariants", () => {
  it("seeds a control map at gen, one entry per non-shipyard station", () => {
    const world = freshWorld(SEEDS[0]);
    expect(world.control).toBeDefined();
    let factioned = 0;
    for (const loc of Object.values(world.locations)) {
      if (loc.traits.faction) {
        factioned++;
        const m = world.control![loc.id];
        expect(m, `${loc.id} missing control map`).toBeDefined();
        expect(m![loc.traits.faction]).toBe(1.0);
      }
    }
    expect(factioned).toBeGreaterThan(0);
  });

  it("control values stay normalized to ~1.0 sum per station", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[0]);
    tickN(world, TICKS_LONG);
    if (!world.control) throw new Error("no control state");
    for (const [locId, m] of Object.entries(world.control)) {
      let sum = 0;
      for (const v of Object.values(m)) sum += v;
      expect(sum, `${locId} sum`).toBeCloseTo(1.0, 3);
    }
  });

  it("control values stay non-negative and finite", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[1]);
    tickN(world, TICKS_LONG);
    if (!world.control) throw new Error("no control state");
    for (const [locId, m] of Object.entries(world.control)) {
      for (const [synd, v] of Object.entries(m)) {
        expect(Number.isFinite(v), `${locId}/${synd}`).toBe(true);
        expect(v, `${locId}/${synd}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("LocationTraits.faction stays synced with the dominant control share", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[2]);
    tickN(world, TICKS_LONG);
    if (!world.control) throw new Error("no control state");
    for (const [locId, m] of Object.entries(world.control)) {
      let dominantId: SyndicateId | null = null;
      let dominantShare = 0;
      for (const k in m) {
        if (m[k] > dominantShare) { dominantShare = m[k]; dominantId = k; }
      }
      const loc = world.locations[locId];
      expect(loc.traits.faction, `${locId}`).toBe(dominantId);
    }
  });

  it("control distribution actually evolves — not stuck at the initial snapshot", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[0]);
    const initial = JSON.stringify(world.control);
    tickN(world, TICKS_MEDIUM);
    const later = JSON.stringify(world.control);
    expect(later).not.toBe(initial);
  });
});

describe("syndicate control over long horizons", () => {
  // The headline balance assertion: nobody gets wiped out. If this
  // fails after a parameter change, the new constants are pushing
  // dominance too hard — bump decay down or trade-rate up.
  it.each(SEEDS)("seed %i: every syndicate keeps at least one station after a long run", { timeout: TEST_TIMEOUT_MS }, (seed) => {
    const world = freshWorld(seed);
    tickN(world, TICKS_LONG);
    const counts = factionStationCounts(world);
    for (const synd of Object.values(world.syndicates)) {
      const count = counts.get(synd.id) ?? 0;
      expect(count, `${synd.name} (${synd.id}) ended with ${count} stations on seed=${seed}`).toBeGreaterThan(0);
    }
  });

  it.each(SEEDS)("seed %i: no syndicate dominates more than 70% of stations after a long run", { timeout: TEST_TIMEOUT_MS }, (seed) => {
    const world = freshWorld(seed);
    tickN(world, TICKS_LONG);
    const counts = factionStationCounts(world);
    const total = Array.from(counts.values()).reduce((s, v) => s + v, 0);
    if (total === 0) return;
    let max = 0;
    let leader = "";
    for (const [k, v] of counts) {
      if (v > max) { max = v; leader = k; }
    }
    const frac = max / total;
    expect(frac, `${leader} owns ${(frac * 100).toFixed(1)}% on seed=${seed}`).toBeLessThan(0.7);
  });

  it.each(SEEDS)("seed %i: every syndicate retains a measurable presence by total share", { timeout: TEST_TIMEOUT_MS }, (seed) => {
    const world = freshWorld(seed);
    tickN(world, TICKS_LONG);
    const totals = totalShareBySyndicate(world);
    // A syndicate that's been completely steamrolled would drop near
    // zero. Threshold: at least 0.5 station-equivalents (a few small
    // contested footholds, or one mostly-owned station).
    for (const synd of Object.values(world.syndicates)) {
      const total = totals.get(synd.id) ?? 0;
      expect(total, `${synd.name} total share = ${total.toFixed(2)} on seed=${seed}`).toBeGreaterThan(0.5);
    }
  });

  it("station count + faction map round-trip cleanly across a long run (no orphaned entries)", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[0]);
    tickN(world, TICKS_LONG);
    if (!world.control) throw new Error("no control state");
    // Every entry in control must point at a real station; every
    // station with a faction stamp must have a corresponding entry.
    for (const locId of Object.keys(world.control)) {
      expect(world.locations[locId], `orphan control entry ${locId}`).toBeDefined();
    }
    for (const loc of Object.values(world.locations)) {
      if (loc.traits.faction) {
        expect(world.control[loc.id], `${loc.id} missing entry despite faction`).toBeDefined();
      }
    }
  });
});

describe("control mechanics: focused activity", () => {
  // Sustained activity by a rival syndicate at a single station has to
  // be able to flip ownership eventually — otherwise the system is
  // inert and the player can't actually take territory. This test
  // simulates ~80 player-rate trades at a target station and asserts
  // the station's faction stamp changes hands.
  it("sustained player-rate activity flips a station's faction", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[0]);
    // Pick any station with a real owner and a non-owner syndicate to
    // become the rival.
    const target = Object.values(world.locations).find(loc => loc.traits.faction) ?? null;
    expect(target).not.toBeNull();
    const targetId: LocationId = target!.id;
    const initialOwner = target!.traits.faction!;
    const rival = Object.values(world.syndicates).find(s => s.id !== initialOwner);
    expect(rival).toBeDefined();

    // Simulate large rival-syndicate trades. Player rate so a handful
    // of nudges can shift the dial within the test budget.
    const TRADES = 80;
    const CREDITS_PER_TRADE = 800;
    for (let i = 0; i < TRADES; i++) {
      nudgeStationControl(world, targetId, rival!.id, CREDITS_PER_TRADE * PLAYER_TRADE_PER_CREDIT);
    }
    // Run a few ticks so applyFactionFlips re-syncs traits.faction.
    tickN(world, 4);

    expect(world.locations[targetId].traits.faction, `station should have flipped from ${initialOwner} to ${rival!.id}`).toBe(rival!.id);
    expect(world.control![targetId][rival!.id]).toBeGreaterThan(0.5);
  });

  // Mirror at NPC weight: an equivalent volume of NPC trade is
  // enough to shift a contested station too, just slower. Validates
  // that NPCs can move the map (per the user's spec) and not just
  // the player.
  it("sustained NPC-rate activity also moves the dial, just slower", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[1]);
    const target = Object.values(world.locations).find(loc => loc.traits.faction);
    expect(target).toBeDefined();
    const targetId: LocationId = target!.id;
    const initialOwner = target!.traits.faction!;
    const rival = Object.values(world.syndicates).find(s => s.id !== initialOwner);
    expect(rival).toBeDefined();

    const initialOwnerShare = world.control![targetId][initialOwner];
    // Same trade count and per-trade credits as the player test —
    // NPC rate is roughly an order of magnitude smaller, so the
    // expectation is meaningful movement (not necessarily a flip).
    for (let i = 0; i < 80; i++) {
      nudgeStationControl(world, targetId, rival!.id, 800 * NPC_TRADE_PER_CREDIT);
    }
    tickN(world, 2);

    const finalOwnerShare = world.control![targetId][initialOwner] ?? 0;
    const rivalShare = world.control![targetId][rival!.id] ?? 0;
    expect(finalOwnerShare, "owner share should drop").toBeLessThan(initialOwnerShare);
    expect(rivalShare, "rival should accumulate measurable share").toBeGreaterThan(0.05);
  });

  // Crossing toll: charged to ships docking at a station owned by a
  // different syndicate. Own-territory and independent (no faction)
  // stations are toll-free.
  it("tollForArrival charges FOREIGN_DOCK_TOLL when the station belongs to a different syndicate", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    const foreign = Object.values(world.locations).find(
      l => l.traits.faction && l.traits.faction !== ship.syndicateId,
    );
    expect(foreign).toBeDefined();
    ship.location = foreign!.id;
    const result = tollForArrival(world, ship);
    expect(result.fee).toBe(FOREIGN_DOCK_TOLL);
    expect(result.toSyndicate).toBe(foreign!.traits.faction);
  });

  it("tollForArrival is free in own territory", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    // Player starts at their own outpost, so the default location is
    // already own-territory.
    const result = tollForArrival(world, ship);
    expect(result.fee).toBe(0);
    expect(result.toSyndicate).toBeNull();
  });

  it("tollForArrival is free at independent (no faction) stations", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    const independent = Object.values(world.locations).find(l => !l.traits.faction);
    expect(independent, "test world must have a shipyard for this assertion").toBeDefined();
    ship.location = independent!.id;
    const result = tollForArrival(world, ship);
    expect(result.fee).toBe(0);
  });

  it("isOwnTerritory tracks the trader's syndicate vs. station faction", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    expect(isOwnTerritory(world, ship)).toBe(true);
    const foreign = Object.values(world.locations).find(
      l => l.traits.faction && l.traits.faction !== ship.syndicateId,
    );
    ship.location = foreign!.id;
    expect(isOwnTerritory(world, ship)).toBe(false);
  });

  it("territoryBuyBonus + territorySellBonus apply only in own territory", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    expect(territoryBuyBonus(world, ship)).toBe(OWN_TERRITORY_BUY_BONUS);
    expect(territorySellBonus(world, ship)).toBe(OWN_TERRITORY_SELL_BONUS);
    const foreign = Object.values(world.locations).find(
      l => l.traits.faction && l.traits.faction !== ship.syndicateId,
    );
    ship.location = foreign!.id;
    expect(territoryBuyBonus(world, ship)).toBe(0);
    expect(territorySellBonus(world, ship)).toBe(0);
  });

  // Player reputation: starts at 0 with all foreign syndicates, can be
  // bumped up to 1.0, and effectiveToll scales the fee inversely with
  // reputation. NPCs always pay the base fee regardless of player state.
  it("playerReputationWith defaults to 0 for any syndicate", () => {
    const world = affiliatedWorld(SEEDS[0]);
    for (const synd of Object.values(world.syndicates)) {
      expect(playerReputationWith(world, synd.id)).toBe(0);
    }
  });

  it("bumpPlayerReputation clamps to 0..1", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const someSynd = Object.keys(world.syndicates)[0];
    bumpPlayerReputation(world, someSynd, 0.3);
    expect(playerReputationWith(world, someSynd)).toBeCloseTo(0.3);
    bumpPlayerReputation(world, someSynd, 5);
    expect(playerReputationWith(world, someSynd)).toBe(1);
    bumpPlayerReputation(world, someSynd, -10);
    expect(playerReputationWith(world, someSynd)).toBe(0);
  });

  it("effectiveToll scales linearly with player reputation", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const ship = world.traders[world.player!.shipIds[0]];
    const foreign = Object.values(world.locations).find(
      l => l.traits.faction && l.traits.faction !== ship.syndicateId,
    );
    expect(foreign).toBeDefined();
    const foreignId = foreign!.traits.faction!;

    expect(effectiveToll(world, foreignId, true)).toBe(FOREIGN_DOCK_TOLL);
    bumpPlayerReputation(world, foreignId, 0.5);
    expect(effectiveToll(world, foreignId, true)).toBeCloseTo(FOREIGN_DOCK_TOLL * 0.5);
    bumpPlayerReputation(world, foreignId, 0.5);
    expect(effectiveToll(world, foreignId, true)).toBe(0);
  });

  it("effectiveToll for NPCs ignores player reputation entirely", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const foreignId = Object.keys(world.syndicates)[1];
    bumpPlayerReputation(world, foreignId, 1);
    // Player would pay nothing. NPCs always pay base.
    expect(effectiveToll(world, foreignId, false)).toBe(FOREIGN_DOCK_TOLL);
    expect(effectiveToll(world, foreignId, true)).toBe(0);
  });

  // Station flip via tickControl emits a news event with paired effects:
  // a positive share-price bump for the seizing syndicate and a matching
  // negative for the previous owner. The toast pipeline picks these up
  // through tickWorld's newsSpawned aggregation.
  it("tickControl emits a flip news event when dominance changes", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const target = Object.values(world.locations).find(loc => loc.traits.faction);
    expect(target).toBeDefined();
    const targetId: LocationId = target!.id;
    const ownerId = target!.traits.faction!;
    const rival = Object.values(world.syndicates).find(s => s.id !== ownerId);
    expect(rival).toBeDefined();

    // Force a flip: rival now dominant.
    world.control![targetId] = { [ownerId]: 0.4, [rival!.id]: 0.6 };
    const report = tickControl(world);

    expect(report.spawnedNews).toHaveLength(1);
    const ev = report.spawnedNews[0];
    expect(ev.templateId).toBe("station_flip");
    expect(ev.headline).toContain(rival!.name);
    expect(ev.headline).toContain(target!.name);
    // Expect a positive effect on the rival, negative on the prior owner.
    const positive = ev.effects.find(e => e.direction === 1);
    const negative = ev.effects.find(e => e.direction === -1);
    expect(positive?.target.id).toBe(rival!.id);
    expect(negative?.target.id).toBe(ownerId);
    // Faction should now be flipped on the live world.
    expect(world.locations[targetId].traits.faction).toBe(rival!.id);
  });

  it("tickControl emits no flip event when dominance is unchanged", () => {
    const world = affiliatedWorld(SEEDS[0]);
    const report = tickControl(world);
    expect(report.spawnedNews).toHaveLength(0);
  });

  // With decay zeroed, a station's control state should stay put when
  // nothing is happening — only activity moves the dial. We call
  // tickControl directly (no NPC traffic) and assert the contested
  // shares are exactly the same after 200 ticks. The faction stamp
  // still resyncs to the dominant on the first tickControl, which is
  // the only state change allowed in the no-activity case.
  it("with no activity, control state is stable across pure tickControl runs", { timeout: TEST_TIMEOUT_MS }, () => {
    const world = freshWorld(SEEDS[2]);
    const target = Object.values(world.locations).find(loc => loc.traits.faction);
    expect(target).toBeDefined();
    const targetId: LocationId = target!.id;
    const ownerId = target!.traits.faction!;
    const rival = Object.values(world.syndicates).find(s => s.id !== ownerId);
    expect(rival).toBeDefined();

    world.control![targetId] = { [ownerId]: 0.45, [rival!.id]: 0.55 };
    // First tick syncs the faction stamp to the new dominant.
    tickControl(world);
    const snapshot = JSON.stringify(world.control![targetId]);
    for (let i = 0; i < 200; i++) tickControl(world);

    expect(JSON.stringify(world.control![targetId])).toBe(snapshot);
    expect(world.locations[targetId].traits.faction).toBe(rival!.id);
  });
});
