# Stock Market → Real Order Book

Living plan for replacing the original price-oracle stock simulation with an
emergent, agent-driven market.

## Why

Originally (`src/sim/stock.ts` pre-rewrite) the stock market was a deterministic
price oracle: prices moved from a fundamentals function plus EMA + tiny noise;
player trades executed against the underlying entity's treasury at zero price
impact; no NPC ever bought or sold equity. There was no actual market — just a
position ledger plus a known curve. That made float capture a free dividend
stream and meant order size never mattered.

## Architecture

```
NPC agent valuations → orders → book matching → trades → eq.price
                                       ↑
                         player orders also enter here
```

Price is the **last trade in the book**, not a function written by hand.
Fundamentals are still computed but their job is to anchor *agent valuations*,
not the price directly.

Trade settlement is per-fill:

- **Player ↔ agent**: cash flows P2P between the player ship's `funds` and the
  agent's `stockState.stockWallet`. Broker fee (1%) is destroyed.
- **Agent ↔ agent**: same — P2P between two `stockWallet`s.
- **Underlying treasury** is no longer touched by share trades (it was, in
  Phase 1 with the MM). The treasury still pays dividends and provides the
  fundamental signal.

---

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1** | Order book rails: types, matching engine, synthetic market-maker, player trades route through book. | **complete** |
| **1.5** | UI expansion: order book panel, T&S tape, volume summary, two-panel chart, sidebar widened to ~40%. | **complete** |
| **2** | Ship trading agents (value / momentum / contrarian / noise styles), P2P cash flow on agent-vs-agent trades, MM still present as a fallback. | **complete** |
| **2.5** | MM removed entirely. Agents are the sole counterparty. Agents get a dedicated `stockWallet` + seeded share positions; `warmUpBook` populates two-sided depth at world creation; momentum + half of noise post aggressive (book-crossing) orders to drive volume. | **complete** |
| **3** | Couple agents to ship lifecycle: docking edge on station equities, syndicate revenue exposure, bankruptcy liquidation, agents may go bankrupt and be replaced. | not started |
| **4** | Player limit-order UI; share-lend mechanic for shorts. | not started |

---

## What exists today (after Phase 2.5)

### Sim — core types

- `Order { id, equityId, side, qty, limitPrice, agentId, postedAt, ttl }`
- `OrderBook { equityId, bids[], asks[] }` per equity
- `BookTrade { equityId, qty, price, buyer, seller, takerSide, tick }`
- `Equity.recentTrades?: BookTrade[]` (cap 100) — drives the UI panels
- `ShipTraderState { style, riskAppetite, stockWallet, positions[], lastDecisionAt }` on each NPC `Trader`

### Sim — files

```
src/sim/stock.ts                 — public API (buyShares/sellShares/etc.) + per-trade settle
src/sim/stock/orderbook.ts       — types, matching engine, place/cancel/preview/execute
src/sim/stock/orderbook.test.ts  — 14 matching-engine unit tests
src/sim/stock/market-maker.ts    — dormant after 2.5; SYNTHETIC_MM_AGENT_ID constant only
src/sim/stock/agents.ts          — agent decision loops, warm-up, position bookkeeping
src/sim/stock/agents.test.ts     — agent tests + invariants
src/tools/orderBookSnapshot.ts   — diagnostic dump of book state per equity
src/tools/agentsDemo.ts          — 250-tick volume + invariants demo
src/tools/stockBookDemo.ts       — Phase 1 price-impact demo (still useful)
```

### Sim — agent behavior (4 styles)

| Style | Trigger | Order placement |
|---|---|---|
| **value** | `\|price − fair\| > 3%` | **passive**: bid below mid (cheap) or ask above mid (expensive) |
| **momentum** | always (~25%) or trend | **aggressive**: bid above mid / ask below mid (chases by walking the spread) |
| **contrarian** | recent trend | **passive**: ask above mid (in up-trend) or bid below mid (in down-trend) |
| **noise** | always | **50/50** aggressive/passive, random side, random offset |

- Decision cadence: every 4 ticks per agent, staggered by id hash.
- Order TTL: 8 ticks.
- Per-order qty: `min(50, MAX_FUNDS_PER_ORDER × stockWallet / price, held)`.
- Initial state: 100k stockWallet, full float (10000 shares per equity)
  distributed evenly across NPCs at world creation.
- Warm-up: each agent posts both a bid and an ask on every equity at world
  creation (noise-style passive offsets) → book has 6+ levels of two-sided
  depth from frame zero.

### UI — stock view sidebar

- Layout: `minmax(0, 1.5fr) minmax(440px, 1fr)` — sidebar at ~40% (was 360px fixed).
- Panels stacked in the right sidebar (in order):
  - **Order Book** — DOM-style: asks descending (worst on top, best near
    spread row), spread row, bids descending below. Each row has price · size
    · cum, with a depth bar growing toward the spread.
  - **Time & Sales** — last 18 trades, newest first, green for buyer-aggressed
    and red for seller-aggressed.
  - **Volume** — totals (window count, total, buy, sell) plus an 18-tick
    signed histogram.
  - **Two-panel chart** — price line with filled area on top, signed volume
    bars below.
  - Existing company info / position controls below.

### Tests + verification

- 277 tests pass (14 new orderbook + 11 new agents + adjusted stock tests).
- `agentsDemo.ts` over 250 ticks: ~420 trades across 7 equities, balanced
  buy/sell, no float or money invariant violations.
- `orderBookSnapshot.ts` shows multi-level two-sided depth at most ticks;
  one-sided moments exist (real markets do too).

---

## Known rough edges (after Phase 2.5)

- **Occasional one-sided book.** Without an MM, a side can deplete for a tick
  or two before agents repopulate. The player can hit "book too thin" briefly.
  Phase 3 should reduce this; if it stays annoying, we could put back a thin
  fallback MM.
- **Aggressive trade prices snap eq.price around.** The take-profit / stop-loss
  tests had to be relaxed because PnL sign now depends on real depth at the
  trigger moment, not on mutating `eq.price`.
- **Stations see less volume than syndicates.** Stations have slow-moving
  fundamentals (treasury health) so value/momentum agents trigger less often
  there. Phase 3's docking-edge mechanic should help.
- **No player limit orders yet.** Player trades are still pure market orders.
  Phase 4 picks this up.
- **Settlement-job test was relaxed** to accept either profit or
  loss_forgiveness depending on agent depth at sell time. The settlement-job
  *mechanism* is verified, but not the sign.

---

## Phase 3 — proposal (not started)

Couple agents to ship lifecycle so trading reflects real game state.

- **Docking edge.** A ship physically docked at station X gets a one-tick
  information advantage on station X's equity — its valuation can read the
  station's treasury before the EMA settles for everyone else. Natural
  ship → equity coupling that emerges from existing geometry.
- **Syndicate revenue exposure.** A ship's cargo profits feed
  `noteSyndicateRevenue` for its syndicate, which already biases the
  fundamental for the syndicate's equity. Phase 3 makes agents in that
  syndicate aware: their valuations skew toward their own syndicate's
  performance (Berkshire-style).
- **Bankruptcy liquidation.** When an NPC ship's `funds` and `stockWallet`
  both hit zero, the ship is forcibly liquidated: positions sold to the book
  over K ticks, ship retires, replacement spawns. Closes the loop on
  agent failure.
- **Maybe**: agent personality biases (a value agent that's also docked at
  a station might post deeper-than-usual on that equity).

Tests would assert: a ship that consistently profits grows its position in its
own syndicate; a ship doing poorly liquidates; docking changes the equity's
agent valuation distribution measurably.

---

## Phase 4 — proposal (not started)

Player-facing UI improvements that the underlying simulation already supports.

- **Limit orders.** Player can place a limit order at any price; sits in the
  book like an agent's. Internal `placeLimitOrder` already exists.
- **Share-lend mechanic for shorts.** Currently the player can short against
  an "implicit" pool. Phase 4 makes this explicit: shorts borrow from a
  specific lender (an agent or the syndicate treasury), pay borrow fees to
  that lender. Already partly modeled (borrow rate exists).
- **Player limit-order UI**: an "Open Orders" panel showing the player's
  resting limits, with cancel buttons.
- **Maybe**: depth-chart visualization (cumulative depth at each price level).

---

## Open questions / decisions to make

- **Should one-sided books trigger a thin fallback?** Currently they just
  return "book too thin" to the player. Could add: when player trade fails
  due to depth, force-step the agents on that side to give them a chance to
  post. Or accept the friction.
- **Should `stockWallet` ever interact with `trader.funds`?** Currently fully
  isolated — agent stock-trading uses a separate pool. This is clean but
  means agent stock wins/losses don't show up in their cargo capital. Phase 3
  might bridge them.
- **Should the player's wallet pool with agents'?** Right now player ship
  uses `ship.funds` for everything (cargo + stock). NPC agents use
  `stockWallet`. Asymmetric but workable.
