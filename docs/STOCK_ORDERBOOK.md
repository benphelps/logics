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
| **3** | Couple agents to ship lifecycle: docking edge on station equities, syndicate revenue exposure, bankruptcy liquidation. | **complete** |
| **4** | Player limit-order UI (place/cancel buy and sell limits with funds + share reservations). Share-lend mechanic for shorts deferred to a follow-up. | **complete** |
| 5 | (Deferred) Explicit share-lend mechanic for shorts: name a specific lender (agent or treasury) at short open, route borrow fees to them, surface borrow availability per lender. Currently shorts work via implicit float adjustment with borrow fees flowing to treasury — fine in practice. | not started |

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

### Phase 3 — ship lifecycle coupling

- **Docking edge.** When an NPC is physically docked at station X
  (`trader.state === "idle" && trader.location === eq.underlyingId`), all
  styles get a 50% qty boost on that equity. Value-style additionally
  tightens its trigger band from ±3% to ±1.5% (`DOCKING_TRIGGER_TIGHTEN`).
  The ship's physical presence at the station translates to deeper
  conviction and more reactive trading on that equity.
- **Syndicate exposure bias.** When an agent computes fair value for an
  equity their ship belongs to (a syndicate equity, via `synd.memberShipIds`),
  the fair value is biased upward by 8% (`SYNDICATE_OWNERSHIP_BIAS`). Members
  are naturally bullish on their own syndicate; ownership skews toward
  members; the syndicate's price floor is supported by its own ships.
- **Bankruptcy liquidation.** When an agent's `stockWallet` drops below
  10k (`BANKRUPTCY_THRESHOLD`), they enter liquidation mode: instead of
  running their normal style, they post aggressive asks for 25%
  (`LIQUIDATION_FRACTION`) of each held position per decision tick, at
  0.5% below mid (`LIQUIDATION_AGGRESSION`) so the ask crosses bids.
  Once stockWallet recovers above the threshold, they resume normal
  style trading.

### Tests + verification

- 280 tests pass (14 orderbook + 14 agents including 3 new Phase 3 tests +
  adjusted stock tests).
- `agentsDemo.ts` over 250 ticks of a default world:
  - **541 trades** across 7 equities (up from 420 pre-Phase-3, 35 with
    pure-passive agents).
  - Stations now see 60-70 trades each (vs. 0-5 early in Phase 2) — the
    docking edge is the main driver.
  - Syndicates: 80-100 trades each, 1/7 equities meets the aspirational
    100/equity criterion.
  - Float and money invariants hold throughout.
- `orderBookSnapshot.ts` shows multi-level two-sided depth most ticks.

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

### Phase 4 — player limit orders

- **Sim API:** `placeLimitBuy`, `placeLimitSell`, `cancelPlayerLimit`,
  `listPlayerLimits` exported from `stock.ts`. Buy limits debit
  `qty × price × (1 + fee)` from `ship.funds` at placement (refunded on
  cancel for unfilled qty). Sell limits track `Player.reservedShares` to
  prevent double-sell of the same shares via market orders or other
  limits.
- **Per-tick fill settlement:** `settlePlayerLimitFills` runs in
  `tickStockMarket` after `matchBook`. When a player limit fills, the
  player's position grows (buys) or shrinks (sells), funds are credited
  net of fee (sells), and `reservedShares` is decremented (sells).
- **UI:** new `LimitOrderPanel` in `CompanyPane`. Side toggle (Buy / Sell),
  qty + price inputs, summary line showing reserved funds (buy) or
  expected net proceeds (sell), and an Open list below showing the
  player's resting limits for that equity with cancel buttons.
- **Share-lend deferred** to a future phase. Current shorts work via
  implicit float adjustment (player short + counterparty long =
  float-conserved) and the existing borrow-fee mechanism flows fees to
  treasury. Making the lender explicit is a meaningful design exercise
  that doesn't change gameplay materially, so we wait until Phase 4's
  limit-order foundation has been used in play.

### Tests

- 7 new player-limit tests in `stock.test.ts` (47 stock tests total):
  buy reserves funds correctly; cancel refunds in full; sell reserves
  shares; can't oversize a sell beyond `held - reserved`; cancel
  decrements reservedShares; placing a buy limit above the current ask
  fills via matchBook on the next tick and the position grows;
  `listPlayerLimits` returns only the player's resting orders.
- 287 total tests pass.

---

## Resolved design decisions

- **One-sided book friction is accepted as-is.** Without an MM, the player
  may occasionally see "book too thin" rejections for a tick or two while
  the depleted side waits for an agent to repost. This is real-market
  behavior and the friction is part of the gameplay — Phase 3's mechanics
  should reduce it organically without needing a fallback MM.
- **Agent `stockWallet` stays isolated from `trader.funds`.** Equity trading
  uses its own pool; cargo trading uses `trader.funds`. Clean separation,
  easy to reason about, and lets agents trade equities even when their
  cargo wallet is thin.
- **Player keeps the unified wallet** (`ship.funds` covers cargo + stock).
  Asymmetric vs. NPC agents but intentional: it's deeper play for the
  player to balance both demands against one budget.
