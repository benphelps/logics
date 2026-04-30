import { describe, expect, it, beforeEach } from "vitest";
import { createWorld } from "../world";
import { tickWorld } from "../tick";
import { eventMultiplier } from "./modifier";
import { createNewsEventsState, tickNewsEvents } from "./tick";
import { setNewsPoolForTests, getNewsPool } from "./pool";
import type { ActiveNewsEvent, NewsEventTemplate } from "./types";

function freshWorld() {
  return createWorld({ player: null });
}

beforeEach(() => {
  setNewsPoolForTests([]);
});

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
    // grain is category "food"
    expect(eventMultiplier(w, "commodity_price", { goodId: "grain" })).toBeCloseTo(0.90, 4);
    // ore is category "raw" — should not match
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
    ev.expiresAt = 95; // past
    w.newsEvents!.active.push(ev);
    const report = tickNewsEvents(w, []);
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
    tickNewsEvents(w, []);
    expect(w.newsEvents!.active).toHaveLength(1);
  });
});

describe("news/spawn — determinism + cadence", () => {
  it("two fresh worlds with the same tick & pool spawn the same event", () => {
    const pool = miniPool();
    setNewsPoolForTests(pool);
    const a = freshWorld(); const b = freshWorld();
    a.tick = 30; b.tick = 30;
    const ra = tickNewsEvents(a, pool);
    const rb = tickNewsEvents(b, pool);
    expect(ra.spawned.length).toBe(rb.spawned.length);
    if (ra.spawned.length > 0) {
      expect(ra.spawned[0].templateId).toBe(rb.spawned[0].templateId);
      expect(ra.spawned[0].headline).toBe(rb.spawned[0].headline);
      expect(ra.spawned[0].expiresAt).toBe(rb.spawned[0].expiresAt);
    }
  });

  it("never spawns when pool is empty", () => {
    const w = freshWorld();
    for (let t = 0; t < 1000; t++) {
      w.tick = t;
      const r = tickNewsEvents(w, []);
      expect(r.spawned).toHaveLength(0);
    }
  });

  it("never spawns when disabled", () => {
    const w = freshWorld();
    w.newsEvents!.enabled = false;
    const pool = miniPool();
    for (let t = 0; t < 600; t++) {
      w.tick = t;
      tickNewsEvents(w, pool);
    }
    expect(w.newsEvents!.active).toHaveLength(0);
  });
});

describe("news — long-run mean reversion", () => {
  it("bias on each scope stays near zero across 5000 ticks", () => {
    const w = freshWorld();
    const pool = balancedMiniPool();
    setNewsPoolForTests(pool);
    for (let t = 0; t < 5000; t++) {
      tickWorld(w);
    }
    const state = w.newsEvents!;
    for (const [, value] of Object.entries(state.bias)) {
      expect(Math.abs(value)).toBeLessThan(0.5);
    }
  });
});

describe("news — wired into tickWorld", () => {
  it("populates report.newsSpawned / newsExpired", () => {
    const pool = miniPool();
    setNewsPoolForTests(pool);
    const w = freshWorld();
    let saw = false;
    for (let i = 0; i < 200; i++) {
      const r = tickWorld(w);
      if (r.newsSpawned.length > 0) saw = true;
    }
    expect(saw).toBe(true);
  });

  it("does not break determinism — same seed ticks identically", () => {
    const pool = miniPool();
    setNewsPoolForTests(pool);
    const a = freshWorld(); const b = freshWorld();
    for (let i = 0; i < 300; i++) { tickWorld(a); tickWorld(b); }
    expect(a.tick).toBe(b.tick);
    expect(a.newsEvents!.active.length).toBe(b.newsEvents!.active.length);
    expect(a.newsEvents!.nextEventId).toBe(b.newsEvents!.nextEventId);
  });
});

// --- helpers ----------------------------------------------------------------

function makeActive(opts: {
  scope: import("./types").NewsScope;
  magnitude: number;
  direction: 1 | -1;
  target?: import("./types").NewsTarget;
}): ActiveNewsEvent {
  const target = opts.target ?? { kind: "global" };
  return {
    uid: `news-test-${Math.random().toString(36).slice(2, 8)}`,
    templateId: "test-template",
    spawnedAt: 0,
    expiresAt: 999_999,
    effects: [{ scope: opts.scope, target, direction: opts.direction, magnitude: opts.magnitude }],
    headline: "Test Event",
    body: "Test body",
    category: "test",
    tone: "info",
  };
}

function miniPool(): NewsEventTemplate[] {
  return [
    {
      id: "test-storm-001",
      category: "weather",
      headline: "Solar storm batters {station}",
      body: "Maintenance crews scramble across {station} to weather the flare.",
      effects: [{ scope: "maintenance", target: { kind: "location" }, direction: 1, magnitude: 0 }],
      durationBand: "short", magnitudeBand: "medium",
      placeholderRequirements: { station: true },
    },
    {
      id: "test-festival-001",
      category: "festival",
      headline: "{station} hosts a homecoming festival",
      body: "Crowds drive demand for {good}.",
      effects: [{ scope: "commodity_price", target: { kind: "good" }, direction: 1, magnitude: 0 }],
      durationBand: "medium", magnitudeBand: "low",
      placeholderRequirements: { station: true, good: true },
    },
  ];
}

function balancedMiniPool(): NewsEventTemplate[] {
  // Mix of up and down for the same scope so the bias balances over time.
  return [
    {
      id: "bal-up-001",
      category: "weather",
      headline: "Disruption strikes",
      body: "Costs rise.",
      effects: [{ scope: "maintenance", target: { kind: "global" }, direction: 1, magnitude: 0 }],
      durationBand: "short", magnitudeBand: "medium",
    },
    {
      id: "bal-dn-001",
      category: "discovery",
      headline: "Efficiency breakthrough",
      body: "Costs fall.",
      effects: [{ scope: "maintenance", target: { kind: "global" }, direction: -1, magnitude: 0 }],
      durationBand: "short", magnitudeBand: "medium",
    },
  ];
}

void getNewsPool; // type-check the import
