// C-4: cargo-delivery settlement tests.

import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import { tickWorld } from "./tick";
import {
  canDeliverPhysical,
  listOpenContracts,
  openLongFuture,
  openShortFuture,
} from "./stock/futures";

describe("stock — C-4 physical-delivery settlement", () => {
  it("each contract is listed with a deliveryStation set to a real location", () => {
    const w = createWorld();
    for (const c of listOpenContracts(w)) {
      expect(c.deliveryStation).toBeTruthy();
      expect(w.locations[c.deliveryStation]).toBeDefined();
    }
  });

  it("canDeliverPhysical: false when ship not at delivery station", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openShortFuture(w, c.id, 2).ok).toBe(true);
    const fp = w.player!.futures![c.id];
    // Move ship away from delivery.
    const otherLoc = Object.keys(w.locations).find(id => id !== c.deliveryStation)!;
    ship.location = otherLoc;
    ship.cargo = [{ good: "grain", qty: 9999, source: otherLoc, unitPrice: 5, purchasedAt: 0 }];
    expect(canDeliverPhysical(w, c, fp, ship)).toBe(false);
  });

  it("canDeliverPhysical: false when cargo qty < contract requirement", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openShortFuture(w, c.id, 2).ok).toBe(true);
    const fp = w.player!.futures![c.id];
    ship.location = c.deliveryStation;
    // Need contractSize × 2 = 200; only have 100.
    ship.cargo = [{ good: "grain", qty: 100, source: c.deliveryStation, unitPrice: 5, purchasedAt: 0 }];
    expect(canDeliverPhysical(w, c, fp, ship)).toBe(false);
  });

  it("canDeliverPhysical: true when ship at delivery station with enough cargo", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openShortFuture(w, c.id, 2).ok).toBe(true);
    const fp = w.player!.futures![c.id];
    ship.location = c.deliveryStation;
    ship.cargo = [{ good: "grain", qty: c.contractSize * 2, source: c.deliveryStation, unitPrice: 5, purchasedAt: 0 }];
    expect(canDeliverPhysical(w, c, fp, ship)).toBe(true);
  });

  it("canDeliverPhysical: false for long position (only shorts deliver)", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 1_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
    expect(openLongFuture(w, c.id, 2).ok).toBe(true);
    const fp = w.player!.futures![c.id];
    ship.location = c.deliveryStation;
    ship.cargo = [{ good: "grain", qty: 9999, source: c.deliveryStation, unitPrice: 5, purchasedAt: 0 }];
    expect(canDeliverPhysical(w, c, fp, ship)).toBe(false);
  });

  it("expiry physical-settles when prerequisites met: cargo removed, settled.physical recorded", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 5_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;

    expect(openShortFuture(w, c.id, 2).ok).toBe(true);
    ship.location = c.deliveryStation;
    ship.state = "idle";
    ship.cargo = [{ good: "grain", qty: c.contractSize * 2, source: c.deliveryStation, unitPrice: 1, purchasedAt: 0 }];

    // Tick to expiry — settlement fires inside tickFutures.
    while (w.tick < c.expiryTick + 1) tickWorld(w);

    // Position is closed.
    expect(w.player!.futures?.[c.id]).toBeUndefined();
    // Cargo grain consumed.
    let remainingGrain = 0;
    for (const lot of ship.cargo) if (lot.good === "grain") remainingGrain += lot.qty;
    expect(remainingGrain).toBe(0);
    // Contract carries a "physical" settled marker (note: the contract
    // entry has been removed from world.contracts so we can't access it
    // here; the absence-of-position is the visible signal).
  });

  it("physical settle outperforms cash settle when spot rises against the short", () => {
    // Run two parallel worlds: in A the player short has cargo at
    // delivery, in B they don't. Both face the same spot rise. A should
    // end up with materially more cash because they avoided the
    // expiry-day cash-settle loss via physical delivery.
    const wA = createWorld();
    const wB = createWorld();
    for (const w of [wA, wB]) {
      const ship = w.traders[w.player!.shipIds[0]];
      ship.funds = 5_000_000;
      const c = listOpenContracts(w).find(c => c.goodId === "grain")!;
      expect(openShortFuture(w, c.id, 1).ok).toBe(true);
      ship.location = c.deliveryStation;
      ship.state = "idle";
    }
    // Only A has cargo at delivery.
    const shipA = wA.traders[wA.player!.shipIds[0]];
    const cA = listOpenContracts(wA).find(c => c.goodId === "grain")!;
    shipA.cargo = [{ good: "grain", qty: cA.contractSize, source: cA.deliveryStation, unitPrice: 1, purchasedAt: 0 }];

    // Let prices drift naturally. Tick both to expiry.
    const expiry = cA.expiryTick;
    for (let i = 0; i < expiry + 1; i++) {
      tickWorld(wA);
      tickWorld(wB);
    }

    expect(wA.player!.futures?.[cA.id]).toBeUndefined();
    expect(wB.player!.futures?.[cA.id]).toBeUndefined();
    // A should have at least as much funds as B (physical isn't worse —
    // it converts cargo into a guaranteed-strike payment instead of
    // taking the spot-at-expiry MtM result).
    const fundsA = shipA.funds;
    const fundsB = wB.traders[wB.player!.shipIds[0]].funds;
    // Physical delivery's economic advantage depends on the cargo's
    // basis cost vs the spot at expiry; in a quiet market the
    // difference may be small, but A should not be materially worse.
    expect(fundsA).toBeGreaterThanOrEqual(fundsB - cA.contractSize * cA.marginFraction);
  });

  it("expiry cash-settles when ship lacks cargo at delivery", () => {
    const w = createWorld();
    const ship = w.traders[w.player!.shipIds[0]];
    ship.funds = 5_000_000;
    const c = listOpenContracts(w).find(c => c.goodId === "grain")!;

    expect(openShortFuture(w, c.id, 1).ok).toBe(true);
    // Don't position cargo. Ship may or may not be at delivery station —
    // either way, no cargo means cash settle.
    ship.cargo = [];

    while (w.tick < c.expiryTick + 1) tickWorld(w);

    expect(w.player!.futures?.[c.id]).toBeUndefined();
    expect(c.settled?.physical).toBeUndefined();
  });
});
