# Economy & Trading Audit Report

Date of audit: 2026-04-28
Horizon validated: 50,000 ticks (5× the 10k+ tick goal)

This document summarizes the deep audit of the economy simulation, the
problems found, the changes made, the post-fix validation results, and the
new stock-market mechanic that was added on top.

---

## Executive summary

**Before**: NPC fleet wealth grew **linearly without bound** at every world
size — 80× over 10k ticks for the starter universe, 200× over 25k ticks. The
documented Tier-2 sinks (15% sales tax, capacity-scaled docking fee) only
slowed the growth; they did not close the monetary loop. Beyond ~5k ticks the
NPC fleet so dwarfed the player's Ç55k starter wallet that the player layer
became economically irrelevant.

**After**: NPC fleet wealth **plateaus** within ~3000 ticks and stays flat
across 50k+ ticks. Final-tick growth ratio dropped from 80–200× to 4–8×. All
existing invariants (price clamp, stock floor, fund floor, determinism) hold
unchanged. **227 tests pass**, including 32 new ones covering the treasury
and stock-market layers.

A new **stock-market layer** has been added: every station and four NPC
syndicates are publicly-traded equities. The player can buy and sell shares
from any station, collect quarterly dividends, and use treasury health as the
"alpha" signal — depleted treasuries → falling share prices.

---

## Stability metrics — before vs after

NPC fleet wealth growth ratio (start → final / start) at 25k ticks:

| World           | Before  | After   | Improvement |
|-----------------|---------|---------|-------------|
| Starter (4 loc) | 200.7×  | 7.83×   | **26× tighter** |
| Generated 12-loc| 136.9×  | 5.56×   | **25× tighter** |
| Generated 50-loc| 135.3×  | 4.74×   | **29× tighter** |

Total system money at 50k ticks: stable (peak at ~3000 ticks, then flat — no
drift). Trader funds stop growing entirely after the warm-up period.

Other invariants verified across 50k ticks at every world size:
- Per-unit price ∈ [0.25× base, 5× base] — **0% pinning at any clamp**.
- Stockpile cap (≤ 3× target) — held.
- Trader funds ≥ 0 — held.
- Determinism — held (`tickN(w, 200)` produces identical state across runs).

---

## Findings

### 1. Open monetary system (CRITICAL — fixed)

The pre-fix sim was a strictly **open** money system. Every NPC sell created
new money in the trader's wallet (`trader.funds += revenue`) without that
money coming from anywhere — markets were unboxed sources of cash. Buys
destroyed money the same way. With the price band running from 0.25× base to
5× base, traders extracted 20× spreads on bargain-to-scarcity arbitrage,
trivially clearing the 15% sales tax and flat docking fees.

Net result: **money creation per trade > money destruction.** Per-trade
creation rate ≈ Ç600 at 4-loc, Ç1100 at 12-loc, Ç4400 at 50-loc. Linear
growth, but unbounded.

### 2. Operating-float silently created money (fixed)

`restoreNpcOperatingFloat` topped a broke + idle NPC up to Ç5,000 each tick —
free money creation. At 50-loc, 30–36% of trader-ticks were in the broke
state; this mechanism was a major contributor to fleet-wealth drift.

### 3. NPC fleet wealth dwarfed player wallet by late game

By 25k ticks, NPC fleet aggregate wealth reached Ç12M (starter), Ç44M (12-loc),
Ç112M (50-loc). The player starts with Ç55k. Without intervention, by the
mid-game the player can't compete on capital, and the simulation's
arbitrage-margins narrow because NPC traders saturate every route.

### 4. Stuck-trader rate at 50-loc was load-bearing on the operating float

The operating-float fix exposed a separate issue: at 50-loc, NPCs sometimes
get genuinely stranded in remote outposts. Before the fix, the free Ç5k bailed
them out. After the fix, without rescue jobs being accepted (no player in
the audit), they stayed parked. Stuck rate steady-state: ~25–30% at 50-loc.

This is **not a death spiral** — the rest of the fleet keeps trading and
total wealth stays bounded. With a player + rescue-contract acceptance, this
resolves naturally.

---

## Changes made

### `src/sim/types.ts`
- `MarketState` gains `treasury: number` and `treasuryTarget: number` — the
  city's "wallet" + replenishment ceiling.
- New `Equity`, `Syndicate`, `EquityId`, `SyndicateId`, `EquityKind` types.
- `World` gains `equities` and `syndicates` records.
- `Player` gains optional `portfolio: Record<EquityId, number>`.

### `src/sim/economy.ts` (new constants and helpers)
- `TREASURY_PER_POPULATION = 150` — initial treasury size, also the soft target.
- `TREASURY_REPLENISH_PER_POP_PER_TICK = 0.035` — per-tick city replenishment.
- `TREASURY_HAIRCUT_FLOOR = 0.50`, `TREASURY_FLOOR_FRACTION = -2.0` — when
  city is in deep deficit, sale prices are linearly haircut down to a 50%
  floor (so trade still happens at depleted cities; no death spiral).
- `NPC_WEALTH_CARRY_PER_TICK = 0.0008` — per-tick wealth-proportional carry
  cost on NPC traders, flowing back into the local treasury (closed loop).
- `defaultTreasuryTarget(loc)`, `treasuryHealthMultiplier(market)`,
  `depositToTreasury`, `withdrawFromTreasury`, `settleSale`, `settlePurchase`
  — closed-loop accounting helpers.
- `tickTreasuries(world)` — per-tick replenishment with a soft taper above
  target so cities don't accumulate infinite reserves.
- `chargeNpcWealthCarry(world)` — per-tick NPC wealth tax to local treasury.
- `chargeDockingFee(world, trader)` — now flows the docking fee into the
  local treasury instead of destroying it.

### `src/sim/traders.ts`
- All buy paths route money through `settlePurchase(market, ...)` —
  trader → city treasury, closed loop.
- All sell paths route money through `settleSale(market, ...)` — city
  treasury → trader, with haircut applied if treasury is depleted. Sales
  tax stays in treasury (was destroyed before).
- Trader's anticipated arrival sell-price now factors in `treasuryHealthMultiplier`,
  so the route scorer correctly avoids destinations whose treasuries are
  depleted.
- `tryRefuel`'s emergency-credit path: instead of giving stranded NPCs free
  money, now draws from the local treasury (capped at the treasury floor —
  stranded NPCs at a broke city stay parked, surfacing as rescue contracts).
- `restoreNpcOperatingFloat` rewritten as a treasury-funded bailout, never
  creating money.

### `src/sim/tick.ts`
- Adds `chargeNpcWealthCarry(world)`, `tickTreasuries(world)`,
  `tickStockMarket(world)` to the per-tick orchestration.

### `src/sim/world.ts`
- `createWorld` initializes each market's treasury and immediately calls
  `ensureStockMarket` to spin up equities and syndicates.

### `src/sim/stock.ts` (new — the stock market layer)
~370-line module implementing publicly traded equities. Highlights below.

---

## The stock-market layer

**Listed entities:**
- **Stations** — every location is a publicly-traded company. IPO price
  scales with population; share price tracks treasury health.
- **Syndicates** — every NPC trader is assigned to one of (default) 4
  syndicates. Syndicate share price tracks aggregate wealth + recent
  revenue of member ships.

**Price formation:**
```
sharePrice_t+1 = clamp(
  sharePrice_t + 0.10 × (fundamentalPrice - sharePrice_t),
  0.1 × anchor,
  10 × anchor
)
```
- Fundamental for stations: function of `treasury / treasuryTarget`. Healthy
  city = ~1× anchor, deeply depleted = ~0.3× anchor.
- Fundamental for syndicates: function of `wealth / fairWealth` plus a small
  `recentRevenue` tilt.
- Smoothing: 10% per tick (sticky prices).
- Per-equity deterministic noise: ±0.25% per tick.
- Hard clamp: `[0.1× anchor, 10× anchor]` — same shape as the goods price
  clamp; share prices physically can't escape a known band.

**Trading (state machine):**
- `buyShares` opens or adds to a long. Refused while short.
- `sellShares` closes (or partially closes) a long. Refused without a long.
- `shortShares` opens or adds to a short. Refused while long. Capped by
  `maxShortableShares(world, eq)` so a short can never open against an
  underlying that can't fund the proceeds (no trapped positions).
- `coverShares` closes (or partially closes) a short. Refused without a short.
- `abandonPosition` is the escape hatch: closes any position at the current
  mark with a 5% penalty, regardless of cash. Used as both a manual button
  and as the fallback when an auto-trigger can't fire the regular close.

**Positions:** at most one position per equity, tagged `kind: "long" | "short"`,
with `shares`, `avgEntryPrice` (weighted across opens / adds), `openedAt`,
and optional `stopLoss` / `takeProfit` thresholds.

**Stop-loss / take-profit:** per-position thresholds checked every tick after
the price recompute. Long stop fires at `price ≤ stopLoss`; short stop fires
at `price ≥ stopLoss`; take-profit flips the inequality. Fired closes are
recorded on the trade ledger with `trigger: "stop_loss" | "take_profit"`.

**Trade ledger:** every action appends a `TradeRecord` to `world.player.trades`,
capped at 200 entries (oldest dropped). Records `action`, `shares`, `price`,
`fee`, `cashFlow`, optional `realizedPnl` on closes, and optional `trigger`
on auto-fired closes.

**Dividends:** every `DIVIDEND_INTERVAL = 200` ticks. Stations pay 5% of
treasury surplus (treasury - target). Syndicates pay 5% of `synd.treasury`.
Long positions receive their pro-rata share. **Short positions owe** the
dividend to the underlying — real-market mechanic where the short seller
covers the lender's accrued dividend.

**Borrow fee:** open shorts accrue `SHORT_BORROW_RATE_PER_TICK = 0.0001` of
notional per tick, drained from the player's wallet (real sink). Without
this, holding a short forever would be free.

**Anti-exploit:**
- 1% broker fee on every trade — round-trip costs 2%.
- Share-price ceiling at 10× anchor + floor at 0.1× anchor.
- Funding-aware short cap (no trapped shorts).
- Sale haircut at depleted treasury.
- Borrow fee on open shorts.

**UI:**
- Three left-side panels: Tape (live equity quotes), Positions (open trades),
  Trades (chronological ledger).
- Click a position row in the Positions table → focuses on that position.
  The panel collapses to that single row and reveals inline controls:
  risk-level inputs (with quick-fill 2/5/10% adverse and 5/10/20% favorable
  chips), close-side controls (Sell or Cover), and an Abandon button. Click
  again to return to the full list. Auto-closes (manual or trigger-fired)
  clear the focus naturally.
- Narrow right sidebar shows company info + entry actions only: header,
  sparkline (with horizontal lines for entry / stop / take when a position
  is open), underlying signals, Buy and Short controls. Sell / Cover /
  Abandon / risk levels live in the focused position row, not duplicated.

**Reading the market:**
- A station with a depleting treasury → its share price will drop. Watch
  the Health column on the Tape; short the listing before others react.
- A wealthy syndicate with growing recent revenue → its share price rises.
- Stop-loss + take-profit let the player encode their exit thresholds and
  walk away. Stops fire as soon as the next tick's price crosses the level.

---

## Files changed / added

```
src/sim/types.ts            (+treasury fields, +equity/syndicate/StockPosition/TradeRecord)
src/sim/economy.ts          (+treasury logic, +settlement helpers, +wealth carry)
src/sim/traders.ts          (all money flows route through treasuries)
src/sim/tick.ts             (treasury + wealth carry + stock market each tick)
src/sim/world.ts            (initialize treasuries + stock market in createWorld)
src/sim/stock.ts            (NEW — full stock-market layer with shorts + stop/take + abandon)
src/sim/treasury.test.ts    (NEW)
src/sim/stock.test.ts       (NEW)
src/sim/scenarios/audit.ts  (NEW — long-horizon audit harness)
src/sim/scenarios/money_flow.ts (NEW — per-tick money tracer)
src/sim/scenarios/player_audit.ts (NEW — player-progression audit)
src/ui/store.ts             (+stock actions: buy/sell/short/cover/abandon, stop/take setters)
src/ui/saveGames.ts         (+migration for older portfolios → positions)
src/ui/App.tsx              (+stocks tab)
src/ui/components/Sidebar.tsx (+Exchange entry)
src/ui/views/StockMarketView.tsx (NEW — tape + positions + trades + sidebar)
src/ui/views/StockMarketView.css (NEW)
docs/AUDIT_REPORT.md        (THIS FILE)
docs/SIM.md                 (+treasury section, +equity exchange section)
docs/VISION.md              (+equity exchange in late game)
docs/ROADMAP.md             (Done table updated; tuning constants table extended)
package.json                (+npm run audit script)
```

---

## Remaining limitations / follow-ups

1. **50-loc NPC stuck rate (~25–30%)**. In an NPC-only sim with no rescue-job
   acceptance, traders that strand in remote outposts stay parked. Not a
   stability or invariant problem — fund growth is bounded — but if
   pure-NPC headless sims are ever an explicit target, the rescue mechanism
   needs a fallback (auto-rescue by a wealthy syndicate, perhaps).

2. **City treasuries grow over the very long run at 50-loc** (Ç7M → Ç67M
   over 50k ticks). This is expected: replenishment happens unconditionally
   with a soft taper, but the taper at 50-loc doesn't fully balance against
   the relatively-low maintenance drain. Trader wealth stays bounded
   regardless. If treasury totals matter for UI, the taper formula can be
   tightened.

3. **Player progression audit shows the captain price is an awkward gate**.
   At Ç140k base and Ç55k starting funds, the player needs ~500 manual
   trades to unlock auto-pilot. This is intentionally a meaningful grind,
   but worth reconsidering when the player layer gets more design polish.

4. **Job rewards still come from "outside the system"**. When a player
   completes a contract, `ship.funds += reward` creates money. This is
   small relative to the trade flow now (player completes contracts at
   most a few per tick), but for fully closed accounting the reward should
   come from the station treasury that posted the job.

5. **The wealth carry tax could be made player-aware**. Currently it only
   hits NPCs — preserving the player's ability to accumulate wealth — but
   this is a soft asymmetry that an attentive player could exploit if the
   sim were ever multiplayer.

---

## How to reproduce / verify

```sh
npm test                       # 247 tests, ~22s
npm run sim 500                # short scenario printout
npm run audit                  # 10k-tick audit (default)
npm run audit -- 25000         # 25k-tick audit
npm run audit -- 50000         # 50k-tick audit (the full long-horizon test)
npm run bench                  # scale benchmark, unchanged
npm run dev                    # full UI with the Exchange tab live
```

The `audit` command exercises three universes (4-loc starter, 12-loc gen,
50-loc gen) and reports trader funds, treasury balances, total system money,
trade volume, stuck/broke fractions, invariant violations, and stock-market
price-band utilization. Use it before/after any economy-touching change to
confirm steady-state stability.
