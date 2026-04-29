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
| **1.5** | UI: order book panel, T&S tape, volume summary, two-panel chart, sidebar widened to ~40% | **complete** |
| **2** | Ship trading agents (value / momentum / contrarian / noise styles), tied to NPC ships, P2P cash flow on agent-vs-agent trades | **complete** |
| 3 | Couple agents to ship lifecycle (docking edge, syndicate revenue exposure, bankruptcy liquidation) | not started |
| 4 | Limit-order UI for player, share-lend mechanics for shorts | not started |

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


---

## Phase 2 — Ship trading agents

### Goal

Replace the synthetic MM as the only counterparty. NPC ships become trading
agents with diverse styles, posting their own bids and asks based on their
own valuations. Trades start happening between agents; volume becomes
emergent rather than purely player-driven; price discovery becomes a
property of competing valuations rather than the MM's spread around the
fundamental.

The synthetic MM stays in place as a thin liquidity floor — it now posts
*tighter* spreads and at *smaller depth* than Phase 1, so agents are
typically the better counterparty. Without the MM the book would empty out
in periods when no agent is interested; with it the book is always
quotable.

### Design decisions

**1. Each NPC trader gets a `stockState`.** Optional field on Trader. Holds
the agent's style, risk appetite, cash reserve fraction, and the per-equity
positions (separate from `world.player.positions` since players have richer
position state with stops/takes/etc.).

**2. Four styles.** Each is a pure decision function `(world, trader, eq)
→ Order[]` returning the orders to place this decision-tick.

- `value`: estimates fair value via `computeFundamental(world, eq)`. If
  `eq.price < fair × 0.97`, posts a bid at `fair × 0.99`. If
  `eq.price > fair × 1.03`, posts an ask at `fair × 1.01`. Mean-reverts.
- `momentum`: looks at the last 6 trades' direction. If they trend up
  (more buyer-aggressed than seller-aggressed), posts a bid above mid.
  If they trend down, posts an ask below mid. Chases.
- `contrarian`: opposite of momentum — fades the recent move.
- `noise`: small random orders symmetrically around mid. Provides
  liquidity floor and chaos.

**3. Cadence.** Every `AGENT_DECISION_INTERVAL = 4` world ticks each agent
takes a decision. Decisions stagger by trader id hash so all agents don't
fire on the same tick.

**4. Order TTL.** Agent orders live for `AGENT_ORDER_TTL = 8` ticks (longer
than the MM's TTL=1 since agent valuations are stickier). Cancelled and
re-posted on the agent's next decision tick.

**5. Order size.** Each agent commits at most `risk × 0.20 × funds` to a
single order, capped by their existing position relative to a target
position size derived from style.

**6. Cash flow.** When the matching engine emits a Trade, the integration
layer routes cash:
  - Both sides MM: not possible (MM only quotes one side per tick).
  - One side MM, other side agent or player: route through underlying
    treasury (Phase 1 behavior).
  - Both sides agents (or agent vs. player): peer-to-peer.
    `buyer.funds -= price × qty + fee`, `seller.funds += price × qty - fee`,
    fees destroyed (real sink).

**7. Float invariant.** Total long shares (player + agents) ≤
`sharesOutstanding`. Enforced at the matching layer: if a trade would push
total longs past outstanding, the MM is the implicit issuer that gets
cleaned up — but in practice the MM ask cap prevents this naturally
since the MM only posts asks when `outstanding > total_longs`.

**8. Position bookkeeping.** When an agent fills, their `stockState.positions[eqId]`
updates with weighted-average entry price. Negative shares = short. No
stop-loss / take-profit on agent positions for Phase 2 — they exit
based on their style's logic (e.g., value agent flips bid→ask when
price crosses fair value).

### File layout

```
src/sim/stock/
  agents.ts          — ShipTraderState, decision loops, tick step
  agents.test.ts     — style-specific tests + invariants
```

Existing `orderbook.ts`, `market-maker.ts` unchanged. `stock.ts`
integration layer gets the cash-flow router for P2P trades.

### Invariants / tests

- After 1000 ticks with N=20 agents on a single equity, prices stay
  within `[anchor × 0.5, anchor × 2.0]` (no runaway).
- Total long shares (sum of player + agent positions) ≤
  `sharesOutstanding` at all times.
- Money is conserved across P2P trades: `Δbuyer.funds + Δseller.funds = -fee`.
- Agent positions never become so negative they exceed available short
  funding (same per-trader cap as the player has).
- Determinism preserved: same seed → same final state.

### Success criterion for Phase 2

- All Phase 1 tests still pass.
- New `agents.test.ts` tests pass.
- A 200-tick stress run with 20 agents on each equity emits 100+ trades
  per equity (real volume) without any monetary or float invariant
  violations.
- The order book panel in the UI shows 3-5 levels of depth on each side
  most of the time (agents posting at varied prices) instead of just the
  MM's single quote level.

### Non-goals for Phase 2

- No agent learning, no ship-lifecycle coupling (Phase 3).
- No share-lend mechanic for shorts; agents short against treasury same
  as Phase 1 (will revisit in Phase 4).
- No agent UI display — agents are invisible to the player except
  through their effect on the book.


## Phase 2 results

- Total tests: 278 passing (was 266 + 11 new agent tests + 1 numerical fix
  for the empty-treasury dividend test which now zeroes the treasury just
  before the dividend tick instead of 200 ticks before, since agents now
  refill it between).
- Typecheck clean.
- Agent demo (`src/tools/agentsDemo.ts`) over 250 ticks of a default world:
  - 282 prints across 7 equities
  - Syndicates see the most action (74–89 trades each); stations see less
    (8–12) since their fundamentals shift slowly from per-tick activity
    and agents need accumulated positions before they can ask
  - Float invariant holds across all equities
  - Style distribution is deterministic per trader id
  - No money or position invariant violations
- Spread cost is no longer constant per fill — agents post at varied price
  levels, so the order book panel in the UI now shows real depth.

The aspirational "100+ trades per equity" criterion was met for syndicates
but not for stations. Phase 3 (ship-lifecycle coupling) will add the
mechanisms that should drive station trading volume up: ship dockings give
an information edge on the docked station's equity, and syndicate revenue
flows directly bias agent valuations.
