# Stock Market → Real Order Book

Living plan + progress tracker for replacing the price-oracle stock simulation
with an actual order book and (eventually) ship-AI-driven trading agents.

## Why

Today (`src/sim/stock.ts`) the stock market is a deterministic price oracle:
prices move from a fundamentals function plus EMA + tiny noise; player trades
execute against the underlying entity's treasury at zero price impact; no NPC
ever buys or sells equity. There's no actual market — it's a position ledger
plus a known curve. That makes float capture a free dividend stream and means
order size never matters. See conversation thread "Deep Stock Market Audit"
for the full breakdown.

## Target architecture

```
fundamentals → agent valuations → orders → book matching → trades → eq.price
                                                  ↑
                                  player orders also enter here
```

Price becomes the **last trade in the book**, not a function written by hand.
Fundamentals stay computed but their job changes: they anchor *agent valuations*,
not the price directly.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1** | Lay the rails: types, matching engine, synthetic market-maker, player trades route through book, existing tests pass | **complete** |
| 2 | Ship trading agents (value / momentum / contrarian / noise styles), tied to NPC ships | not started |
| 3 | Couple agents to ship lifecycle (docking edge, syndicate revenue exposure, bankruptcy liquidation) | not started |
| 4 | UI polish: depth panel, trade tape, limit orders, share-lend mechanics for shorts | not started |

We commit to Phase 1 only right now. Phases 2–4 depend on what Phase 1 reveals.

---

## Phase 1 — Lay the rails

### Goal

Replace the "price = function" model with a real (if thinly populated) order
book. The synthetic market-maker keeps the book liquid; the player's trades
become market orders that walk the book. Functionally the player's experience
is similar but **price impact now exists** for any trade larger than the MM's
quote depth.

### Design decisions

**1. Matching policy.** Price-time priority. Crossing orders match at the
*resting* (older) order's limit price. FIFO at each price level.

**2. Tick-of-stock-market vs world tick.** Order book ages and matches every
world tick (same as today's `tickStockMarket`). Agent decision cadence may
differ in Phase 2 (likely every 4 world ticks), but matching itself runs every
tick so player orders fill promptly.

**3. Order types.**
- `market` — fills against best available across the book; rejects unfilled
  remainder.
- `limit` — sits in the book until matched, cancelled, or expires.
- `ttl` (ticks-to-live) — optional. MM quotes use TTL=1 so the book is rebuilt
  fresh each tick.

**4. Float and supply.** `sharesOutstanding` stays at 10,000 per equity. The
sum of (player long − player short) + (NPC longs − NPC shorts) + (MM
inventory) = 0. The MM inventory is the *deficit* against outstanding (i.e.,
the synthetic MM is the implicit "issuer" of any unowned shares).

**5. Self-trades.** A single agent's bid cannot match its own ask. Skipped at
matching time.

**6. Funding.** Player buys still pull from `trader.funds`. The synthetic MM
draws from / deposits to the underlying treasury (same closed-loop accounting
that exists today). This means Phase 1 has the same money-flow shape as
today; only the *price formation* changes.

**7. Determinism.** Matching is deterministic given a sorted order list. We
sort by price-then-postedAt-then-id at match time so output is stable across
runs.

**8. Equity.price = last-trade price.** If no trade fired this tick, retain
prior price. Fundamentals are still computed but not assigned to `eq.price`;
they become an input to the MM's quote.

**9. Clamp band.** `[0.1× anchor, 10× anchor]` clamp moves to the MM's quote
bounds (it won't quote outside the band). Trades can technically print outside
if the player aggresses against an aggressive MM, but the MM regenerates
inside the band each tick.

**10. Broker fee + borrow fee.** Unchanged — applied per-fill.

### File layout

```
src/sim/stock/
  orderbook-types.ts   — Order, OrderBook, Trade type defs
  orderbook.ts         — match step, place/cancel helpers
  market-maker.ts      — synthetic MM agent, quotes per equity per tick
  index.ts             — re-exports + tickStockMarket integration
src/sim/stock/orderbook.test.ts — matching-engine unit tests
```

`src/sim/stock.ts` keeps its current public surface (`buyShares`, `sellShares`,
etc.) but routes through the book internally.

### Test plan

**New** (orderbook.test.ts):
- Crossing bid+ask at same price → both fully fill
- Crossing bid above ask → trade prints at the resting (ask) price
- Partial fill — bid qty < ask qty → ask remains in book at reduced qty
- Multi-level walk — market order eats two ask levels
- FIFO at same price — earlier order fills first
- Self-trade prevention — same agentId on both sides skips the match
- Determinism — same input order list → same trades emitted

**Existing** (stock.test.ts, 40 tests): all must still pass. A few may need
the assertion tightened from "price exactly X" to "price within tolerance"
because the MM's bid-ask spread now means the executed price differs from the
fundamental by ±2%. Where that happens, document the fix in the test comment.

### Success criterion for Phase 1

- All `stock.test.ts` tests pass (with at most ~5 numerically-relaxed
  assertions, each documented with a comment explaining the relaxation).
- All `orderbook.test.ts` matching tests pass.
- `npx tsc --noEmit` clean.
- A 100-tick run with a single player buy of 5,000 shares shows visible price
  impact (>= 1% upward drift relative to the fundamental over the tick).
  Demo via a tools script.

### Non-goals for Phase 1

- No agent diversity yet (only the synthetic MM trades; NPC ships do not).
- No depth-panel UI; no trade tape UI. Player UI sees the same Buy / Sell /
  Short / Cover buttons, just with different fill prices.
- No limit-order UI. Internal `placeOrder(...)` exists but is invoked only by
  the MM and by the player-trade adapters as market orders.
- No share-lending mechanic for shorts; shorts continue to draw from
  underlying treasury as today.

---

## Progress checklist

- [x] Plan written
- [x] `Order` / `OrderBook` / `Trade` types (`src/sim/types.ts`)
- [x] Matching engine + 14 unit tests (`src/sim/stock/orderbook.ts`, `orderbook.test.ts`)
- [x] Synthetic market-maker agent (`src/sim/stock/market-maker.ts`)
- [x] Player trade adapters route through book (`buyShares` / `sellShares` /
      `shortShares` / `coverShares` in `src/sim/stock.ts`)
- [x] All 40 existing stock tests pass — no relaxations needed; the MM
      refreshes its quotes around `eq.price` on every player-trade entry,
      so direct mutations of `eq.price` in tests are reflected immediately.
- [x] Demo script showing price impact (`src/tools/stockBookDemo.ts`) —
      a 1000-share buy at tick 5 produces +2% immediate impact (the spread)
      and a +12% delta vs. baseline after 25 ticks (treasury enrichment +
      EMA drift toward the new fundamental).

## Phase 1 results

- Total tests: 266 passing (was 252 + 14 new orderbook tests)
- Typecheck clean
- Player trades have visible price impact for the first time
- Spread cost is currently constant per fill (single-level MM); Phase 2's
  diverse agents will provide real walking-the-book depth dynamics

## Open questions / decisions deferred

- Should the MM ever *take* (eat into the player's resting orders) when the
  player's quote is within the MM's spread? Initial answer: no — the MM
  quotes the spread, but it doesn't trade aggressively. Phase 1 keeps the
  MM purely passive (post and refresh). Worth revisiting in Phase 2 once
  agent diversity exists.
- How wide is the MM spread? Starting at ±2% (so ~4% round-trip). Tunable.
- What happens to in-flight settlement jobs (the station equity's "pay
  player on next dock") when the underlying dynamics change? Phase 1: no
  change — settlement-job mechanism is independent of how `eq.price`
  is determined.
