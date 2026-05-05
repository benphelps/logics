# Commodities Trading - Implementation Notes

Commodity, basis, futures, and index markets are now implemented on the
Exchange screen. For the player-facing guide, see
`docs/wiki/EXCHANGE.md`.

> **Status:** implementation reference and design history. The phase notes
> below are useful background, but the current source of truth is the code
> in `src/sim/stock.ts`, `src/sim/stock/futures.ts`, and
> `src/ui/views/StockMarketView.tsx`.

## Why

We have 14 transport goods today (`grain`, `protein`, `vatmeat`, `ore`,
`polymer`, `fiber`, `parts`, `xenospice`, `silk`, `plasma`, `antimatter`,
`electronics`, `weapons`, `luxury_goods`, `medkits`). Right now the player
trades them physically — buy at one station, fly, sell at another. The
local-market price is set by `priceFor(stock, target)` on a 0.25× / 5× clamp.

Commodities trading adds a **second layer** on top of the physical market:
a per-good order book where the player (and NPC agents) can take positions
on the _forward_ price of a good without ever touching cargo. Done well,
this:

1. Couples the existing cargo / station economy to the existing equity
   exchange. Goods prices, station treasuries, and equity prices already
   move together; this exposes that coupling as a tradable edge.
2. Gives the player a way to capitalize on knowledge the physical-trade
   game already requires — "I notice grain on Verdant is glutted while
   Haven is short" — without having to spend ticks on the physical run.
3. Adds a third pillar to the exchange (alongside station + syndicate
   equities) so the screen scales with content.

## Architectural fit

The Phase-4 order book / agent / settlement infrastructure is reusable
**as-is**. Specifically:

- `src/sim/stock/orderbook.ts` is generic over `equityId`. Nothing in it
  cares whether the underlying is a station, a syndicate, or a good.
- `src/sim/stock/agents.ts` already has 4 trading styles, decision
  cadence, and TTL. Re-targeting them at a per-good book is a matter of
  extending the agent's per-equity loop.
- `src/sim/stock.ts` settlement (broker fee, P2P stockWallet flows,
  player-side bookkeeping, settlement jobs) is already factored.

We add two new types — a `CommodityContract` (the listed instrument) and
a `CommodityFundamental` (the equivalent of `computeFundamental` for a
good). Everything else slots into the existing rails.

## Phasing

Six phases, each shippable on its own. Each phase ends with green tests
and a working UI panel.

### Phase C-1 — Spot index per good

The simplest commodity instrument: a _spot index_ tracking the
volume-weighted average market price of a good across all stations.

- Listing per good: `commodity_<goodId>` (e.g. `commodity_grain`).
- `Equity` shape extended with a third `kind: "commodity"`. `underlyingId`
  becomes the `GoodId`. Rest of the order book infrastructure unchanged.
- `computeFundamental` for a commodity:

  ```
  fundamental(good) = Σ_loc (market[loc].prices[good] × market[loc].stock[good])
                     / Σ_loc market[loc].stock[good]
  ```

  The volume-weighted spot. Glutted production sites pull it down,
  shortage sites pull it up. The same anchor / clamp / EMA logic as
  station and syndicate equities applies — we get a 0.1× / 10× clamp
  around an anchor pegged to `good.basePrice`.

- Agents post bids and asks against this fundamental using their
  existing four styles. No new agent code beyond extending the
  per-equity loop.

- Player can long / short commodity contracts the same way they long
  station equities. Settlement is purely cash — there is no physical
  delivery in C-1.

- UI: a new "Commodities" tab on the Exchange screen. Same listings
  pattern, same chart / book / T&S panels.

**Tests:** float invariant per commodity, price-clamp invariant, no
self-trades, system-cash drift bounded. Mirror of the equity tests.

**Why this is enough as a v1:** the player can already extract value
from cargo-market intelligence. They don't have to physically deliver
to profit on a price view. This is the smallest possible commodities
market.

### Phase C-2 — Station basis exposure

Each station's local price for a good is `basis = local_price - spot_index`.
A glutted producer trades at a _negative basis_ (cheaper than spot) and
a hungry consumer at a _positive basis_.

We add **basis pairs** as a derived listing: one per (good, station),
priced as the station's local price minus the spot index. Long basis =
"this station's good is going to be more expensive relative to spot".

- No new order books per pair (would explode count). Instead:
  basis pairs are _synthetic_ — long basis = long the station's
  commodity-station-pair (a virtual equity) priced as
  `local - spot`. Cash settlement only.
- Limited to a handful of "blue chip" pairs (3-5 most-traded
  station / good combos), surfaced by the world generator.
- UI: basis pairs appear in the Commodities tab grouped under their
  good.

This phase is the _information game_ layer — players who watch
production / consumption flows have an edge.

### Phase C-3 — Futures contracts (margin + expiry)

This is the meaty phase. Replaces the C-1 spot-index instrument with
a real **futures contract** for each good with a defined expiry tick.

A contract is described by `(good, expiryTick, contractSize)`:

- `contractSize`: the fixed quantity (in good units) the contract
  represents. e.g. one grain contract = 100 units.
- `expiryTick`: the world tick at which the contract settles cash to
  the spot index of the underlying good.
- `margin`: the upfront collateral the player must reserve to open
  one contract. A small fraction of `contractSize × spot`. This is
  what gives futures their leverage (and risk).

Each good has **two contracts listed at any time**: a near-month
(expires in ~500 ticks) and a far-month (~1500 ticks). When the
near expires, a new far is listed.

**At expiry:**

- Long contract holders are paid `(spot_at_expiry - entry_price) × contractSize`.
- Short holders pay (or receive, if spot fell) the same amount.
- Margin is released back to the player on settlement; PnL flows
  through `ship.funds`.

**Cash flow accounting:**

- Margin reserved at open: locked in `player.reservedFunds` (or
  similar; mirrors `reservedShares`).
- Daily mark-to-market: each tick, agent and player MtM PnL is
  computed, and _variation margin_ is moved between `stockWallet` /
  `ship.funds` and the contract's clearing pool.
- The clearing pool is a per-good escrow that nets out longs and
  shorts. Total system cash is conserved (longs' gains == shorts'
  losses + clearing fees).

**Tests:** expiry settlement is exact, margin is conserved, total
cash balances at expiry, contract listing rolls correctly.

### Phase C-4 — Cargo-delivery settlement

This phase **physically couples** futures to cargo. A player who is
short grain at expiry can choose to settle with **physical delivery**
instead of cash:

- Have grain in the ship's cargo at the listed delivery station, and
  the contract settles at the _contract's strike price_, not the spot.
- Otherwise, default to cash settlement.

This reproduces the most interesting real-world futures mechanic: the
short knows the contract price and can lock it in by procuring physical
goods cheaper elsewhere. It turns cargo trading into a multi-tick
financial game.

**Implementation notes:**

- Contract has a `deliveryStation: LocationId` field set at creation
  (defaults to a major hub).
- When short is the seller, system polls the seller's cargo at the
  delivery station at expiry. If they have ≥ `contractSize` of the
  good there, accept delivery.
- Long takes the cargo: physical inventory shows up in their ship's
  hold (or their port-of-record if they're not docked), with cost basis
  = strike.
- If the long can't accept (no cargo room), default to cash settlement.

**Why this is huge:** it's the first mechanic where the player can
predict their own future trades and get paid for the prediction. A
player who knows they'll have ore on Haven in 500 ticks can short
ore-Haven futures, lock in price, and deliver against the contract
at expiry.

### Phase C-5 — Station ratings / commodity exposure on equity prices

The existing station-equity fundamental is purely treasury-driven. C-5
makes commodity flow visible as a _modifier_ on the station fundamental:

- `fundamental(station_eq) ×=` healthy-of-net-trade modifier.
- Net trade = `Σ exports - Σ imports` (in basis-point cash terms),
  smoothed across N ticks.
- A station that is consistently a _productive seller_ (positive net
  trade) trades at a premium to a station with the same treasury but
  zero export.

This is a small pure-math change to `computeFundamental`. It makes
station equity prices reactive to the commodity layer (and vice versa,
because the station's net-trade flow is what feeds the spot index).

### Phase C-6 — Commodity baskets and indices

Once C-1 through C-5 are in, two derived instruments fall out:

- **Sector indices**: weighted commodity baskets (e.g. "Food index" =
  grain + protein + vatmeat). No physical delivery; pure cash settle.
  Sized so a typical player position represents one ship's cargo
  capacity in equivalent goods.
- **Treasury Index Notes**: a synthetic instrument tracking aggregate
  treasury health across all stations. Tradable like an equity.
  Useful end-game vehicle for someone who wants market-wide exposure.

This phase is about giving the late-game player something to scale into.

---

## Interaction with the existing economy

### Fairness with cargo trading

A player can always do better by _physically delivering_ goods than by
trading paper futures, because physical trade pockets the
station-vs-spot basis (which is exactly what C-2 surfaces). Futures are
a leverage / abstraction layer for players who want to express price
views without physical inventory; the cargo game remains the highest-EV
play for skilled players who can plan routes.

This is the design intent: commodities trading is a **complement** to
cargo, not a replacement.

### Closed-loop money model

We must preserve total-cash conservation modulo the broker-fee burn:

- Per-trade cash flows on commodity trades go through the same
  `stockWallet ↔ stockWallet` (agent ↔ agent) and `ship.funds ↔
stockWallet` (player ↔ agent) paths as equity trades. No new pools.
- Futures clearing (variation margin) is a _transfer_ between long and
  short positions through a per-contract escrow. Net zero.
- Broker fee on contract opens / closes is the only burn, same as
  equities.
- Physical delivery (C-4) routes good units, not cash, between
  ship cargo holds. Cash flow on delivery is the strike price ×
  contract size between long and short. Already conserved.

### NPC agent participation

Agents trade commodities the same way they trade equities. Decision
loops branch on `equity.kind`:

- `station` / `syndicate` → existing fundamentals.
- `commodity` → spot-index fundamental (C-1) or futures-discounted
  fundamental (C-3+, where the contract's fundamental is the spot
  - carry cost to expiry).

Agent style biases stay identical:

- **Value** agents trade commodities heavily once a good's stock vs
  target gets out of whack. This is the cleanest signal in the game.
- **Momentum** agents chase commodity trends — and there are real
  trends because production / consumption rates create autocorrelated
  prices.
- **Contrarian** agents fade overheated commodity moves.
- **Noise** agents post random orders to maintain depth.

No new agent style is needed.

### Tying into station equity ratings

Three couplings, in increasing strength:

1. **Soft (C-1):** none. Spot index is read-only with respect to
   station treasuries.
2. **Medium (C-2):** a station's basis exposure is visible to traders
   but doesn't change the station's equity fundamental. Information
   game only.
3. **Strong (C-5):** station fundamentals get a net-trade modifier.
   Productive stations trade at a premium; lossmaking stations
   discount. This closes the loop: trade flow → station equity →
   syndicate equity (because syndicates own the ships moving the
   trade flow) → back to commodity prices.

By the end of C-5, the four "equities" — stations, syndicates,
commodities, and basis pairs — are all priced off each other. A skilled
player can construct multi-leg arb positions: long Haven station,
short ore basis, long grain spot. Each leg is a price view; combined
they're a thesis on Haven's economy.

### Fairness across instruments

To keep the player from grinding cash via simple round-trip arbitrage:

- Commodity contracts have a broker fee (1%, same as equities). Round
  trip costs at least 2%.
- Futures have a daily mark-to-market and a per-tick clearing fee
  (basis points). Holding indefinitely costs.
- Margin requirements scale with notional, so leverage is bounded.
- Cargo-delivery settlement (C-4) requires real physical cargo at the
  right station — there is no "magic delivery" loophole.

These mirror the existing borrow fee on shorts (`SHORT_BORROW_RATE_PER_TICK`).

---

## UI surface

### Phase C-1

A new **"Commodities"** tab in `StockMarketView.tsx` next to the
existing equity listings. Each commodity row shows ticker (e.g.
"GRN"), name, current spot, anchor (good.basePrice), 24-tick change,
and depth. Clicking opens the same right-pane chart / book / T&S /
order form layout.

### Phase C-3

Add a futures sub-tab. Futures rows additionally show expiry tick,
contract size, margin requirement, open interest. Player position rows
show notional + margin + MtM PnL.

### Phase C-4

A "Settle physical" toggle on shorts approaching expiry, with a
summary of cargo on hand at the delivery station.

### Phase C-5

The station equity card surfaces a new line: "Net-trade modifier:
+8.2%". Click for a breakdown of which goods are contributing.

---

## Risks and open questions

1. **Will the spot-index fundamental be too stable?** A volume-weighted
   average across stations is naturally smoothed. We may want to add
   sensitivity to _recent_ trade flow (similar to syndicate
   `recentRevenue`) to give it more wiggle.

1.a We can unsmooth it or tweak things as needed, levers are good.

2. **Margin sizing.** Too small → player gets liquidated on noise;
   too large → futures are no different from cash spot. Need to tune
   against measured volatility per good — likely 5-10% of notional
   for a stable food good, 15-20% for a luxury or fuel.

2.a Another great place for levers, we can tweak the margin formula as needed.

3. **Delivery loophole audit.** Can a sufficiently clever player
   trigger a long-delivery for cargo they didn't actually have to
   transport? Need to make cargo movement to the delivery station
   verifiable on-chain — the cargo lot's `boughtAt` station / tick
   suggests the ship made the trip.

3.a We can track this as a possible issue and patch if we find an exploit.

4. **Display density.** Adding 14 commodity rows + ~5 basis pairs +
   28 futures listings (14 goods × 2 expiries) = ~47 new listings
   on top of the existing 7-15. Need a tab structure or filter UI
   so the screen doesn't overload. Likely "All / Equities / Stations
   / Syndicates / Commodities" filter chips.

4.a This is exactly what I was thinking UI wise, we can reuse the top-tab panel style for the tab bar.

5. **Save migration.** Adding `kind: "commodity"` to `Equity` is
   straightforward. Adding futures contracts requires a new top-level
   `world.contracts: Record<ContractId, Contract>` map. Save
   versioning will need to bump.

5.a Nuke them, doesn't matter. Saves never matter until I'm clear they do.

6. **Agent style for commodities is imperfect.** A futures contract's
   "fair value" depends on time to expiry (it converges to spot at
   expiry). Value agents should consider this carry, not just current
   spot. Phase C-3 will need a `computeContractFundamental` that
   handles roll convergence; this is the only non-trivial new pricing
   math.

6.a As long as it feels good, doesn't break the game, and gives the player a reasonable chance to out-trade the bots, it's good enough. We can iterate on the agent logic as needed.

---

## What this is NOT

- It is not options. Options would be a separate, even later phase.
  Commodities futures are linear — no convexity. (Options on
  commodities would be C-7 if we ever get there.)
- It is not a portfolio-margin system. Each contract reserves its own
  margin. Cross-margining is a later optimization.
- It is not a commodity producer / refiner mechanic. Production and
  consumption stay where they are; commodities trading is a layer on
  top of the existing production/consumption.

---

## Summary roadmap

| Phase | Adds                                                     | Rough effort                                           |
| ----- | -------------------------------------------------------- | ------------------------------------------------------ |
| C-1   | Spot-index commodities (cash-only longs/shorts per good) | small — extends `Equity.kind`                          |
| C-2   | Station basis pairs (synthetic listings)                 | small                                                  |
| C-3   | Futures contracts with margin + expiry                   | medium-large — new contract types, mark-to-market loop |
| C-4   | Physical cargo delivery on short settle                  | medium — couples cargo + futures                       |
| C-5   | Net-trade modifier on station equity fundamentals        | small                                                  |
| C-6   | Sector indices + Treasury Index Notes                    | small (composes from C-1–C-3)                          |

The work is **incremental and stop-able at any phase**. C-1 alone is a
shippable feature that doubles the size of the exchange.

## Pre-work that helps everything

Before C-1, two refactors clean up the rest of the road:

1. **Generalize `computeFundamental`** so it dispatches by `eq.kind`
   rather than the current two-branch `if station / else syndicate`.
   Prepares the surface for a third branch (commodity) without
   duplication.
2. **Promote `EXCHANGE_TRADE_MAX_HOPS` and other proximity rules** to
   `eq.tradabilityFrom(world, ship)` so each instrument can declare
   its own access rules. Commodities (and basis pairs) probably want
   "any docked station" while station equities keep their hop rule.

Both of these are tiny no-functional-change refactors that pay off
across the entire C-x phase tree.
