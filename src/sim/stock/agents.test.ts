import { describe, it, expect } from "vitest";
import { createWorld } from "../world";
import { tickWorld } from "../tick";
import { listEquities } from "../stock";
import { applyAgentFill, ensureAgentState, initAgent } from "./agents";
import type { Trader } from "../types";

function makeNpcTrader(id: string, funds = 50_000): Trader {
  return {
    id,
    name: id,
    capacity: 50,
    speed: 1,
    fuelCapacity: 100,
    fuelTypes: [{ good: "plasma", perDistance: 1 }],
    currentFuel: { good: "plasma", qty: 100 },
    funds,
    location: "haven",
    state: "idle",
    cargo: [],
    destination: null,
    ticksRemaining: 0,
    pilot: "npc",
    log: [],
  };
}

describe("agents — initialization", () => {
  it("deterministic init: same trader id → same style + risk", () => {
    const a = initAgent(makeNpcTrader("t1"));
    const b = initAgent(makeNpcTrader("t1"));
    expect(a.style).toBe(b.style);
    expect(a.riskAppetite).toBe(b.riskAppetite);
    expect(a.cashReserveFraction).toBe(b.cashReserveFraction);
  });

  it("different ids → diverse styles across the population", () => {
    const styles = new Set<string>();
    for (let i = 0; i < 30; i++) {
      styles.add(initAgent(makeNpcTrader(`t_${i}`)).style);
    }
    // With 30 ships and 4 styles, we should hit at least 3 distinct styles.
    expect(styles.size).toBeGreaterThanOrEqual(3);
  });

  it("ensureAgentState lazy-init populates exactly once", () => {
    const t = makeNpcTrader("t1");
    expect(t.stockState).toBeUndefined();
    const s1 = ensureAgentState(t);
    expect(t.stockState).toBe(s1);
    const s2 = ensureAgentState(t);
    expect(s2).toBe(s1);  // same object
  });
});

describe("agents — applyAgentFill position bookkeeping", () => {
  it("opens a long position with correct entry price", () => {
    const t = makeNpcTrader("t1");
    applyAgentFill(t, "eq_a", 10, 100, 5);
    expect(t.stockState!.positions.eq_a).toEqual({ shares: 10, avgEntryPrice: 100, openedAt: 5 });
  });

  it("adds to a long with weighted-average entry price", () => {
    const t = makeNpcTrader("t1");
    applyAgentFill(t, "eq_a", 10, 100, 1);
    applyAgentFill(t, "eq_a", 10, 200, 2);
    const p = t.stockState!.positions.eq_a;
    expect(p.shares).toBe(20);
    expect(p.avgEntryPrice).toBe(150);  // (10*100 + 10*200) / 20
  });

  it("closing a long deletes the position when shares hit zero", () => {
    const t = makeNpcTrader("t1");
    applyAgentFill(t, "eq_a", 10, 100, 1);
    applyAgentFill(t, "eq_a", -10, 110, 2);
    expect(t.stockState!.positions.eq_a).toBeUndefined();
  });

  it("flipping long → short resets entry price to the flip price", () => {
    const t = makeNpcTrader("t1");
    applyAgentFill(t, "eq_a", 10, 100, 1);
    applyAgentFill(t, "eq_a", -15, 120, 2);
    const p = t.stockState!.positions.eq_a;
    expect(p.shares).toBe(-5);
    expect(p.avgEntryPrice).toBe(120);
  });
});

describe("agents — full-tick integration", () => {
  it("agents trade during tickStockMarket and emit events visible in eq.recentTrades", () => {
    const w = createWorld();
    // Make sure agents have funds to trade with — many seeds spawn NPC ships
    // with modest starting funds. Boost them up a bit so order sizing is not
    // floor-rounded to zero.
    for (const t of Object.values(w.traders)) {
      if (t.pilot === "npc") t.funds = Math.max(t.funds, 200_000);
    }

    // Run enough ticks that all agents have had multiple decision cycles
    // (interval = 4, so 60 ticks ≈ 15 decisions per agent).
    for (let i = 0; i < 60; i++) tickWorld(w);

    // At least one equity should have non-trivial trade volume from agents
    // beyond the synthetic MM. If the test ever flakes here, bump the tick
    // count or NPC funds.
    const eqs = listEquities(w);
    let totalTrades = 0;
    for (const eq of eqs) totalTrades += eq.recentTrades?.length ?? 0;
    expect(totalTrades).toBeGreaterThan(0);
  });

  it("price stays in [0.05× anchor, 20× anchor] across long horizons (relaxed band)", () => {
    // The hard clamp is [0.1×, 10×]. We assert a wider tolerance just to
    // catch runaway agent feedback loops; the clamp itself is verified by
    // existing stock tests.
    const w = createWorld();
    for (const t of Object.values(w.traders)) {
      if (t.pilot === "npc") t.funds = Math.max(t.funds, 200_000);
    }
    for (let i = 0; i < 500; i++) tickWorld(w);
    for (const eq of listEquities(w)) {
      const ratio = eq.price / eq.anchorPrice;
      expect(ratio).toBeGreaterThan(0.05);
      expect(ratio).toBeLessThan(20);
    }
  });

  it("float invariant: long shares (player + agents) ≤ sharesOutstanding", () => {
    const w = createWorld();
    for (const t of Object.values(w.traders)) {
      if (t.pilot === "npc") t.funds = Math.max(t.funds, 200_000);
    }
    for (let i = 0; i < 200; i++) tickWorld(w);
    for (const eq of listEquities(w)) {
      let longShares = 0;
      // Player long
      const playerPos = w.player?.positions?.[eq.id];
      if (playerPos?.kind === "long") longShares += playerPos.shares;
      // Agent longs
      for (const t of Object.values(w.traders)) {
        const ap = t.stockState?.positions[eq.id];
        if (ap && ap.shares > 0) longShares += ap.shares;
      }
      expect(longShares).toBeLessThanOrEqual(eq.sharesOutstanding + 1);
    }
  });

  it("determinism: two worlds same seed produce identical agent positions after N ticks", () => {
    const a = createWorld();
    const b = createWorld();
    for (const t of Object.values(a.traders)) if (t.pilot === "npc") t.funds = 200_000;
    for (const t of Object.values(b.traders)) if (t.pilot === "npc") t.funds = 200_000;
    for (let i = 0; i < 50; i++) { tickWorld(a); tickWorld(b); }

    for (const id of Object.keys(a.traders)) {
      const aPos = a.traders[id].stockState?.positions ?? {};
      const bPos = b.traders[id].stockState?.positions ?? {};
      expect(Object.keys(aPos).sort()).toEqual(Object.keys(bPos).sort());
      for (const eqId of Object.keys(aPos)) {
        expect(aPos[eqId].shares).toBeCloseTo(bPos[eqId].shares, 5);
        expect(aPos[eqId].avgEntryPrice).toBeCloseTo(bPos[eqId].avgEntryPrice, 5);
      }
    }
  });
});
