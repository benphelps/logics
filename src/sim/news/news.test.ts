// News-system tests after the on-demand-generation refactor. The pool
// pick + placeholder substitution is gone; events are now applied via
// applyResolvedNewsEvent when /api/news/event lands. These tests cover:
//   - the modifier query layer (still pure)
//   - tick expiry + recent ring buffer
//   - spawn cadence producing a request spec without firing the API
//   - applyResolvedNewsEvent finalizing a synthetic LLM response
//   - long-run bias balance across many synthetic events

import { describe, expect, it } from "vitest";
import { createWorld } from "../world";
import { tickWorld } from "../tick";
import { eventMultiplier } from "./modifier";
import { createNewsEventsState, tickNewsEvents } from "./tick";
import { applyResolvedNewsEvent, MAX_INFLIGHT_REQUESTS } from "./spawn";
import type { ActiveNewsEvent, NewsEffect, NewsScope, NewsTarget } from "./types";

function freshWorld() {
  return createWorld({ player: null });
}

describe("news/modifier — short-circuits", () => {
  it("returns 1 when world.newsEvents is undefined", () => {
    const w = freshWorld();
    delete w.newsEvents;
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBe(1);
  });

  it("returns 1 when newsEvents.enabled is false", () => {
    const w = freshWorld();
    w.newsEvents = createNewsEventsState();
    w.newsEvents.enabled = false;
    w.newsEvents.active.push(makeActive({ scope: "commodity_price", magnitude: 0.2, direction: 1 }));
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBe(1);
  });

  it("returns 1 when no event matches the scope", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({ scope: "maintenance", magnitude: 0.2, direction: 1 }));
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBe(1);
  });

  it("returns 1 when target.id mismatches ctx.id", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({
      scope: "commodity_price", magnitude: 0.2, direction: 1,
      target: { kind: "good", id: "ore" },
    }));
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBe(1);
  });
});

describe("news/modifier — matching", () => {
  it("matches by exact id", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({
      scope: "commodity_price", magnitude: 0.10, direction: 1,
      target: { kind: "good", id: "grain" },
    }));
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBeCloseTo(1.10, 4);
  });

  it("matches by category", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({
      scope: "commodity_price", magnitude: 0.10, direction: -1,
      target: { kind: "good", category: "food" },
    }));
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBeCloseTo(0.90, 4);
    expect(eventMultiplier(w, "commodity_price", { goodId: "ore" })).toBe(1);
  });

  it("global target matches any ctx", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({
      scope: "maintenance", magnitude: 0.05, direction: 1,
      target: { kind: "global" },
    }));
    expect(eventMultiplier(w, "maintenance", { locationId: "loc_aria" })).toBeCloseTo(1.05, 4);
    expect(eventMultiplier(w, "maintenance", { locationId: "any-id" })).toBeCloseTo(1.05, 4);
  });

  it("two events on the same scope multiply", () => {
    const w = freshWorld();
    w.newsEvents!.active.push(makeActive({
      scope: "maintenance", magnitude: 0.10, direction: 1, target: { kind: "global" },
    }));
    w.newsEvents!.active.push(makeActive({
      scope: "maintenance", magnitude: 0.05, direction: 1, target: { kind: "global" },
    }));
    expect(eventMultiplier(w, "maintenance", {})).toBeCloseTo(1.10 * 1.05, 4);
  });

  it("clamps stacked multipliers within [0.25, 4.0]", () => {
    const w = freshWorld();
    for (let i = 0; i < 30; i++) {
      w.newsEvents!.active.push(makeActive({
        scope: "maintenance", magnitude: 0.25, direction: 1, target: { kind: "global" },
      }));
    }
    expect(eventMultiplier(w, "maintenance", {})).toBeLessThanOrEqual(4.0);
  });
});

describe("news/tick — expiry and recent buffer", () => {
  it("moves expired events to recent and frees the active slot", () => {
    const w = freshWorld();
    w.tick = 100;
    const ev = makeActive({ scope: "maintenance", magnitude: 0.10, direction: 1, target: { kind: "global" } });
    ev.spawnedAt = 90;
    ev.expiresAt = 95;
    w.newsEvents!.active.push(ev);
    const report = tickNewsEvents(w);
    expect(report.expired).toHaveLength(1);
    expect(w.newsEvents!.active).toHaveLength(0);
    expect(w.newsEvents!.recent).toHaveLength(1);
    expect(w.newsEvents!.recent[0].uid).toBe(ev.uid);
  });

  it("keeps active events past tickNewsEvents when not yet expired", () => {
    const w = freshWorld();
    w.tick = 50;
    const ev = makeActive({ scope: "maintenance", magnitude: 0.10, direction: 1, target: { kind: "global" } });
    ev.spawnedAt = 40; ev.expiresAt = 100;
    w.newsEvents!.active.push(ev);
    tickNewsEvents(w);
    expect(w.newsEvents!.active).toHaveLength(1);
  });
});

describe("news/spawn — cadence + request spec", () => {
  it("returns a spawn request when the cadence fires", () => {
    const w = freshWorld();
    let sawRequest = false;
    for (let t = 0; t < 600; t++) {
      w.tick = t;
      const r = tickNewsEvents(w);
      if (r.spawnRequest) {
        sawRequest = true;
        expect(r.spawnRequest.tier).toMatch(/^(world|sector|station|good)$/);
        expect(r.spawnRequest.biasHint).toMatch(/^(favor_negative|favor_positive|neutral)$/);
      }
    }
    expect(sawRequest).toBe(true);
  });

  it("never returns a spawn request when disabled", () => {
    const w = freshWorld();
    w.newsEvents!.enabled = false;
    for (let t = 0; t < 600; t++) {
      w.tick = t;
      const r = tickNewsEvents(w);
      expect(r.spawnRequest).toBeNull();
    }
  });

  it("respects MAX_INFLIGHT_REQUESTS — won't queue while pending count is at the cap", () => {
    const w = freshWorld();
    w.newsEvents!.pendingRequestCount = MAX_INFLIGHT_REQUESTS;
    let queued = 0;
    for (let t = 0; t < 600; t++) {
      w.tick = t;
      const r = tickNewsEvents(w);
      if (r.spawnRequest) queued += 1;
    }
    expect(queued).toBe(0);
  });
});

describe("news/spawn — applyResolvedNewsEvent", () => {
  it("appends the resolved event, increments nextEventId, updates bias", () => {
    const w = freshWorld();
    const before = w.newsEvents!.nextEventId;
    const applied = applyResolvedNewsEvent(w, {
      headline: "Test headline",
      body: "Test body",
      tone: "warn",
      durationBand: "short",
      effects: [{
        scope: "encounter_chance",
        target: { kind: "global" },
        direction: 1,
        magnitude: 0.20,
      }],
    });
    expect(applied).not.toBeNull();
    expect(w.newsEvents!.active).toHaveLength(1);
    expect(w.newsEvents!.nextEventId).toBe(before + 1);
    const biasKey = "encounter_chance|global|*";
    expect(w.newsEvents!.bias[biasKey]).toBeCloseTo(0.20, 5);
  });

  it("rejects events with no usable effects", () => {
    const w = freshWorld();
    const applied = applyResolvedNewsEvent(w, {
      headline: "Bad event",
      body: "",
      effects: [],
    });
    expect(applied).toBeNull();
    expect(w.newsEvents!.active).toHaveLength(0);
  });
});

describe("news — long-run bias balance with synthetic events", () => {
  it("alternating direction events keep bias near zero across many spawns", () => {
    const w = freshWorld();
    let sign = 1;
    for (let i = 0; i < 200; i++) {
      applyResolvedNewsEvent(w, {
        headline: `Synthetic ${i}`,
        body: "",
        durationBand: "short",
        effects: [{
          scope: "maintenance",
          target: { kind: "global" },
          direction: sign === 1 ? 1 : -1,
          magnitude: 0.15,
        }],
      });
      sign = -sign;
    }
    // Bias decays each tick, but we never tick — so the sum-of-deltas is
    // exactly tracked. With perfectly alternating direction the running
    // sum hovers near 0 (final value = 0 if even count, ±0.15 if odd).
    const biasValue = w.newsEvents!.bias["maintenance|global|*"] ?? 0;
    expect(Math.abs(biasValue)).toBeLessThan(0.16);
  });
});

describe("news — wired into tickWorld", () => {
  it("tick reports surface a newsRequest when cadence fires", () => {
    const w = freshWorld();
    let sawRequest = false;
    for (let i = 0; i < 200; i++) {
      const r = tickWorld(w);
      if (r.newsRequest) sawRequest = true;
    }
    expect(sawRequest).toBe(true);
  });
});

// --- helpers ----------------------------------------------------------------

function makeActive(opts: {
  scope: NewsScope;
  magnitude: number;
  direction: 1 | -1;
  target?: NewsTarget;
}): ActiveNewsEvent {
  const target = opts.target ?? { kind: "global" };
  const effect: NewsEffect = { scope: opts.scope, target, direction: opts.direction, magnitude: opts.magnitude };
  return {
    uid: `news-test-${Math.random().toString(36).slice(2, 8)}`,
    templateId: "test-template",
    spawnedAt: 0,
    expiresAt: 999_999,
    effects: [effect],
    headline: "Test Event",
    body: "Test body",
    category: "test",
    tone: "info",
  };
}
