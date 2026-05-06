# Per-tick performance — engine optimization log (2026-05)

Bench scope: capped at 50–100 locations. Profilers at
`src/sim/scenarios/profile.ts` and `src/sim/scenarios/profile_deep.ts`.

All numbers from `seed=42`, 50-tick warmup, then measurement window.
Hardware: same machine across runs (Darwin 25.2.0).

## Optimization plan

1. **#1 Cache `commoditySpotPrice` per (good, tick).** ✅ Done.
2. **#2 Hoist per-tick indices out of `listTradeOptions`.** ✅ Done.
3. **#3 Replace string-key Maps with nested Maps in trader hot loops.** ✅ Done.
4. **#4 Pass inflight map through `listSpeculativeOptions`.** ✅ Done.
5. **#5 Cache equity list once per `tickStockMarket` pass.** ✅ Done.
6. **#6 Memoize world `maxR` for `applyNeighborPressure`.** ✅ Done.
7. **#7 Avoid sort in `stepTraders` ordering.** ✅ Done.

## Baseline (pre-#1)

50 locations / 75 traders / 125 equities, 300 ticks measured:

| metric | value |
|---|---|
| ms/tick | 5.78 |
| ticks/s | 173 |
| `tickStockMarket` | 2.62 ms/tick (45.4%) |
| `stepTraders` | 2.21 ms/tick (38.3%) |
| `commoditySpotHistory` | 0.42 ms/tick (7.3%) |
| `recomputePrices` (markets) | 0.24 ms/tick |

100 locations / 150 traders / 180 equities, 200 ticks measured:

| metric | value |
|---|---|
| ms/tick | 21.93 |
| ticks/s | 46 |
| `tickStockMarket` | 10.17 ms/tick (46.4%) |
| `stepTraders` | 9.57 ms/tick (43.6%) |
| `commoditySpotHistory` | 0.91 ms/tick |

Deep profile sub-timings (50 locs):
- `stepStockAgents`: 1.89 ms/tick
- `recomputePrice` loop (in stockMarket): 0.20 ms/tick
- `listTradeOptions`: 1.49 ms/tick (across all idle traders)

## #1 — Cache `commoditySpotPrice` per (good, tick)

**Change:** `src/sim/stock.ts` — added a `WeakMap<World, { tick, values }>` cache around `commoditySpotPrice`. Mirrors the existing `news/modifier.ts` pattern. Within a tick, `world.markets[].stock` and `.prices` are stable across all callers (production/consumption ran upstream in `tickWorld`), so a per-tick memo is safe. Only the "denom > 0" result is cached — the fallback path is caller-specific and only fires when no inventory exists at all.

**Tests:** all 486 sim tests pass (28.8s suite).

**Results:**

| | before | after | Δ |
|---|---|---|---|
| **50 locs total ms/tick** | 5.78 | 5.64 | −2.4% |
| 50 locs `tickStockMarket` | 2.62 | 2.40 | −8.5% |
| 50 locs `stepStockAgents` (deep) | 1.89 | 1.58 | −16.4% |
| 50 locs `recomputePrice` (deep) | 0.20 | 0.17 | −15.0% |
| **100 locs total ms/tick** | 21.93 | 20.24 | **−7.7%** |
| 100 locs `tickStockMarket` | 10.17 | 8.56 | **−15.8%** |

Savings scale with location count (consistent with prediction: each cache hit avoids an L-loop). At 50 locs the absolute win is ~0.14 ms/tick; at 100 locs it grows to ~1.7 ms/tick. Headroom for `stepStockAgents` was the largest individual recipient (each NPC agent's commodity-equity decision now hits the cache).

## #2 — Hoist per-tick indices out of `listTradeOptions`

**Change:** `src/sim/traders.ts` — introduced `TraderTickIndex` (built once per tick in `stepTraders` via `buildTraderTickIndex(world)`) carrying:
- `inflight` (in-transit cargo by destination → good)
- `unacceptedShortageBonuses` (open shortage jobs by destination → good)
- `acceptedJobsByTrader` (accepted shortage/rescue jobs per trader)
- `acceptedTradeJobsByTrader` (accepted trade-settlement jobs per trader, pre-sorted)

Plumbed through `listTradeOptions`, `evaluateOptions`, `listSpeculativeOptions`, `listRepositionOptions`, and `stepTrader`. The five per-trader `Object.values(world.jobs)` walks (jobBonusMap, reservedMassByDest, two `acceptedTradeJobs(...)` probes, contractLoads filter) collapse to a single jobs walk per tick plus per-trader Map lookups. External callers (`suggestions.ts`) keep working with the lazy local-build fallback.

**Tests:** all 486 sim tests pass (25.2s).

**Results (cumulative through #2):**

| | baseline | after #1 | after #2 | Δ vs baseline |
|---|---|---|---|---|
| **50 locs total ms/tick** | 5.78 | 5.64 | 5.17 | **−10.6%** |
| 50 locs `stepTraders` | 2.21 | 2.27 | 1.81 | −18.1% |
| **100 locs total ms/tick** | 21.93 | 20.24 | 17.08 | **−22.1%** |
| 100 locs `stepTraders` | 9.57 | 9.51 | 6.93 | **−27.6%** |

#2 was the single biggest gain at 100 locs (−3.16 ms/tick). The savings grow with traders × jobs.

## #3 — Replace string-key Maps with nested Maps in trader hot loops

**Change:** `src/sim/traders.ts` — converted two flat string-keyed maps to nested `Map<dst, Map<good, …>>`:
- `inTransitArrivalsByDestGood` and the `TraderTickIndex.inflight` slot.
- `jobBonusMap` inside `listTradeOptions`.

Both are read inside the hot inner double-loop (`for goodId × for dstId`). Eliminates ~17k string-concat allocations/tick at 50 locs (twice that at 100). Updated insertion sites in `executeAutoLoadoutPlan` and the `stepTrader` cargo-departure path to use the nested shape.

**Tests:** all 486 sim tests pass.

**Results (delta from #2):**

| | after #2 | after #3 | Δ |
|---|---|---|---|
| 50 locs total ms/tick | 5.17 | 5.10 | −1.4% |
| 100 locs total ms/tick | 17.08 | 16.78 | −1.7% |

Modest in wall time — the V8 string-intern path is already fast — but reduces per-tick GC pressure and lays groundwork for further hoisting (e.g. swapping the loop nesting later).

## #4 — Pass inflight map through `listSpeculativeOptions`

**Change:** `src/sim/traders.ts` — `listSpeculativeOptions` now accepts the `TraderTickIndex` and forwards it to its K-fan-out `listTradeOptions` calls. When called externally without an index, it still hoists a single inflight Map outside the candidates loop so the K calls share one. Eliminates the prior 6× rescan of all traders' cargo per speculative invocation.

**Tests:** all 486 sim tests pass.

**Results:** folded into the cumulative #2/#3 numbers — the path only fires when a trader has no profitable trade and empty cargo, so the on-paper saving is small but removes a footgun.

## #5 — Cache equity list once per `tickStockMarket` pass

**Change:** `src/sim/stock.ts` — `tickStockMarket` snapshots `Object.values(world.equities)` once at the top instead of three times (across `ageOrders`, `matchBook`, and `recomputeEquityPrice` loops). One array allocation per tick instead of three; same iteration order.

**Tests:** all 486 sim tests pass.

**Results:** ~0.05 ms/tick at 50 locs — small on its own; folded into the cumulative numbers below.

## #6 — Memoize world `maxR` for `applyNeighborPressure`

**Change:** `src/sim/control.ts` — replaced the per-tick `Math.hypot` loop over all locations with a `WeakMap<world.locations, number>` cache. Stations don't move, so the value is invariant for the lifetime of a world; using the locations record as the key means a fresh world (reload, new game) recomputes automatically.

**Tests:** all 486 sim tests pass.

**Results:** invisible at 50 locs in profile noise; ~0.05 ms/tick at 100 locs.

## #7 — Avoid sort in `stepTraders` ordering

**Change:** `src/sim/traders.ts` — replaced `Object.values(world.traders).sort((a, b) => Number(playerIds.has(b.id)) - …)` with: iterate `world.player?.shipIds` first (with a `Set<TraderId>` of seen ids), then iterate the remaining traders. No allocation of an ordered array, no sort.

**Tests:** all 486 sim tests pass.

**Results:** invisible in profile noise but eliminates one O(N log N) sort per tick.

## Cumulative gains over time

```
ms/tick at each step (lower is better)

50 locations / 75 traders / 125 equities
                             ms/tick   bar (each █ = 0.10 ms)
baseline                      5.78    █████████████████████████████████████████████████████████ 100%
after #1 (spot cache)         5.64    ███████████████████████████████████████████████████████▍   97.6%
after #2 (tick index)         5.17    ███████████████████████████████████████████████████        89.4%
after #3 (nested maps)        5.10    ██████████████████████████████████████████████████▍        88.2%
after #4 (spec inflight)      ─       (folded into #2/#3 numbers)
after #5 (equity snapshot)    ─       (in-noise at 50 locs)
after #6 (maxR cache)         ─       (in-noise at 50 locs)
after #7 (no sort)            5.09    ██████████████████████████████████████████████████▍        88.1%

100 locations / 150 traders / 180 equities
                             ms/tick   bar (each █ = 0.50 ms)
baseline                     21.93    ███████████████████████████████████████████ 100%
after #1 (spot cache)        20.24    ████████████████████████████████████████▍    92.3%
after #2 (tick index)        17.08    ██████████████████████████████████▏          77.9%
after #3 (nested maps)       16.78    █████████████████████████████████▌           76.5%
after #5/#6/#7               16.76    █████████████████████████████████▌           76.4%

ticks/sec (higher is better)
                             50 locs       100 locs
baseline                     173 ▕███████  46  ▕████
final                        197 ▕████████ 60  ▕██████   +14% / +30%
```

Cumulative speed-up at 100 locations:

```
% faster than baseline (each █ ≈ 1%)
0%   ▏
                                                                                 ↓ #2 jumps here
#1   ███████▌                                                              7.7%
#2   ██████████████████████▏                                              22.1%
#3   ███████████████████████▌                                             23.5%
final ███████████████████████▌                                            23.6%
```

The big inflection is **#2** — the per-tick job index — because it scales with traders × jobs. #1 is biggest at small scale, #2 dominates from ~50 stations up. Tail items (#3–#7) each shave under 0.1 ms but compound and remove allocation hot-spots.

## Final results (all #1–#7)

300-tick measurement, 50-tick warmup, `seed=42`:

| metric | baseline | final | Δ |
|---|---|---|---|
| **50 locs total ms/tick** | 5.78 | **5.09** | **−11.9%** |
| 50 locs ticks/sec | 173 | **197** | +13.9% |
| 50 locs `tickStockMarket` | 2.62 | 2.41 | −8.0% |
| 50 locs `stepTraders` | 2.21 | 1.74 | **−21.3%** |
| **100 locs total ms/tick** | 21.93 | **16.76** | **−23.6%** |
| 100 locs ticks/sec | 46 | **60** | +30.4% |
| 100 locs `tickStockMarket` | 10.17 | 8.01 | **−21.2%** |
| 100 locs `stepTraders` | 9.57 | 6.66 | **−30.4%** |

All 486 sim tests pass after every change. The win grows superlinearly with world size, as intended — the optimizations target O(traders × goods × locations), O(traders × jobs), and O(equities × locations) terms.

Remaining headroom (not implemented, sized at 100 locs):
- `stepStockAgents` still walks every equity per active agent (~1.89 ms/tick base, ~1.58 after #1). Per-equity work could be batched or sub-cycled further.
- `commoditySpotHistory` still iterates all goods × all locations even though every value gets cached on the same call to `commoditySpotPrice`. A tighter ring-buffer push path could trim ~0.1 ms/tick at 100 locs.
- The inner double-loop in `listTradeOptions` still loops `goods × dests`. Swapping the nesting could let us hoist per-dst Map lookups, but that's an order-of-evaluation refactor we deferred.
