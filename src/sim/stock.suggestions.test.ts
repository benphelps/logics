import { describe, expect, it } from "vitest";
import { createWorld } from "./world";
import { computeEventAdjustedFundamental, listEquities, placeLimitSell } from "./stock";
import { getStockExchangeHint, listStockExchangeHints } from "./stock/suggestions";

function prepareWorld() {
  const w = createWorld();
  const ship = w.traders[w.player!.shipIds[0]];
  ship.funds = 1_000_000;
  ship.state = "idle";
  for (const eq of listEquities(w)) {
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair;
    eq.prevPrice = fair;
  }
  return w;
}

describe("stock exchange suggestions", () => {
  it("suggests a long when a share listing is materially below fair value", () => {
    const w = prepareWorld();
    const eq = listEquities(w).find(e => e.kind === "commodity")!;
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair * 0.8;

    const hint = listStockExchangeHints(w, w.player!.shipIds[0], 20).find(h => h.equityId === eq.id);

    expect(hint?.equityId).toBe(eq.id);
    expect(hint?.kind).toBe("open_long");
    expect(hint?.action).toBe("buy");
    expect(hint?.edgePct).toBeGreaterThan(0.2);
  });

  it("suggests a short when a share listing is materially above fair value", () => {
    const w = prepareWorld();
    const eq = listEquities(w).find(e => e.kind === "commodity")!;
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair * 1.25;

    const hint = listStockExchangeHints(w, w.player!.shipIds[0], 20).find(h => h.equityId === eq.id);

    expect(hint?.equityId).toBe(eq.id);
    expect(hint?.kind).toBe("open_short");
    expect(hint?.action).toBe("short");
    expect(hint?.edgePct).toBeLessThan(-0.15);
  });

  it("prefers closing a long when the position is profitable and the quote is above fair value", () => {
    const w = prepareWorld();
    const eq = listEquities(w).find(e => e.kind === "commodity")!;
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair * 1.2;
    w.player!.positions = {
      [eq.id]: {
        equityId: eq.id,
        kind: "long",
        shares: 12,
        avgEntryPrice: eq.price * 0.7,
        openedAt: w.tick,
      },
    };

    const hint = getStockExchangeHint(w, w.player!.shipIds[0]);

    expect(hint?.equityId).toBe(eq.id);
    expect(hint?.kind).toBe("close_long");
    expect(hint?.action).toBe("sell");
    expect(hint?.positionPnlPct).toBeGreaterThan(0.35);
    expect(hint?.suggestedLimitPrice).toBeGreaterThan(0);
  });

  it("does not keep suggesting shares that are already offered in working sell limits", () => {
    const w = prepareWorld();
    const shipId = w.player!.shipIds[0];
    const eq = listEquities(w).find(e => e.kind === "commodity")!;
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair * 1.2;
    w.player!.positions = {
      [eq.id]: {
        equityId: eq.id,
        kind: "long",
        shares: 12,
        avgEntryPrice: eq.price * 0.7,
        openedAt: w.tick,
      },
    };

    const placed = placeLimitSell(w, eq.id, 5, eq.price * 1.01, shipId);
    expect(placed.ok).toBe(true);

    const partial = listStockExchangeHints(w, shipId, 20).find(h => h.equityId === eq.id);
    expect(partial?.action).toBe("sell");
    expect(partial?.suggestedUnits).toBe(7);
    expect(partial?.workingOrderSide).toBe("ask");
    expect(partial?.workingOrderUnits).toBe(5);

    const placedRest = placeLimitSell(w, eq.id, 7, eq.price * 1.01, shipId);
    expect(placedRest.ok).toBe(true);
    const covered = listStockExchangeHints(w, shipId, 20).find(h => h.equityId === eq.id);
    expect(covered).toBeUndefined();
  });

  it("includes futures contract signals", () => {
    const w = prepareWorld();
    const eq = listEquities(w).find(e => e.kind === "futures")!;
    const fair = computeEventAdjustedFundamental(w, eq);
    eq.price = fair * 0.9;

    const hints = listStockExchangeHints(w, w.player!.shipIds[0], 20);
    const hint = hints.find(h => h.equityId === eq.id);

    expect(hint?.kind).toBe("open_long_future");
    expect(hint?.action).toBe("open_long_future");
    expect(hint?.unitLabel).toBe("ct");
  });
});
