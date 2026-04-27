# Simulation Model

The current state of the sim. All code in `src/sim/`. All paths and constants are concrete and tunable.

## The tick loop

Every call to `tickWorld(world)` runs, in order:

1. **Trader step** — every NPC trader either ticks down a transit countdown (and arrives + sells), or evaluates trade options from its current location and either departs with cargo or sits idle.
2. **Production** — each location runs its `produces` recipes, gated by `requiresTechLevel` and throttled by `productionScale(stock, target)` so glutted producers stop.
3. **Consumption** — each location burns its `consumes` rates. Shortfalls emit `shortage` events.
4. **Reprice** — recompute every market's prices from current stock vs target.
5. **Maintenance** — drain trader funds at `capacity × MAINTENANCE_PER_CAPACITY`, scaled by `MAINTENANCE_IDLE_FACTOR` for docked ships, floored at 0 funds.

`tickWorld` is deterministic given a world. `tickN(world, n)` runs N consecutive ticks. Tested.

## Pricing

```
price = basePrice × clamp((target / stock)^0.6, 0.25, 5.0)
```

This is the central anchor of the entire economy. Prices are bounded in `[0.25× base, 5× base]` *forever*. The basePrice never moves. There is no global inflation vector.

When `target` is 0 (location doesn't model demand for that good), price stays at base regardless of stock.

Constants in `src/sim/pricing.ts`:
- `PRICE_ELASTICITY = 0.6` — how steeply price responds to stock-vs-target deviation
- `PRICE_FLOOR_MULT = 0.25`, `PRICE_CEILING_MULT = 5.0` — the unbreakable band

## World

A `World` holds:
- `goods: Record<GoodId, Good>` — good definitions (basePrice, weight, category)
- `locations: Record<LocationId, LocationDef>` — stations with positions, traits, recipes
- `markets: Record<LocationId, MarketState>` — per-station stock and prices
- `lanes: LaneMap` — optional per-edge distance modifiers
- `traders: Record<TraderId, Trader>` — NPC ships
- `tick: number`

Constructed by `createWorld({ goods?, locations?, lanes?, traders? })`. Defaults seed from `src/sim/data/`.

### Geometry

Locations have `position: { x, y }`. Distances are derived:

```
distance(world, a, b) = euclidean(a.pos, b.pos) × laneModifier(lanes, a, b)
```

`laneModifier` defaults to 1.0, looks up `lanes[a]?.[b]` first, then falls back to `lanes[b]?.[a]` (so symmetric lanes only need one declaration). Asymmetric lanes (e.g. a one-way slingshot) declare both directions.

The lane-modifier system is in place but the starter universe has no lanes declared — every route is pure euclidean. Lanes are a content lever for hazard / jump-lane mechanics later.

Helpers in `src/sim/geometry.ts`: `euclidean`, `laneModifier`, `distance`, `nearestDistance`, `reachableNeighbors`.

### Locations

Each `LocationDef` carries:
- `position` — see Geometry
- `population` — currently informational (no consumption-scaling yet; see ROADMAP)
- `traits: { techLevel, tags[], faction? }`
  - `techLevel` gates tier-2+ production via `requiresTechLevel` on recipes
  - `tags` are free-form descriptors (`"trade-hub"`, `"frontier"`, `"luxury"`, etc.) for filtering and UI flavor
  - `faction` is reserved for future political content
- `primaryExports` / `primaryImports` — declared, hand-curated tags. Tested for consistency with the production data so they can't drift silently.
- `produces[]` — recipes (see below)
- `consumes[]` — flat rates per tick
- `targetStock` — reference stockpile for price formation; a good with no target stays at base price

Helpers in `src/sim/locations.ts`: `netProductionRate`, `isNetExporter`, `locationsExporting/Importing`, `locationsByTag`, `locationsByFaction`, `locationsAtTechLevel`.

### Production recipes

```ts
{
  good: "electronics",
  ratePerTick: 2,
  requiresTechLevel: 7,                           // optional gate
  inputs: [
    { good: "parts", perUnit: 0.5 },
    { good: "antimatter", perUnit: 0.2 },
  ],
}
```

At tick time:
1. If `requiresTechLevel` is set and `loc.traits.techLevel` doesn't meet it, skip.
2. Compute `amount = ratePerTick × productionScale(stock, target)` — taper output as warehouse fills.
3. If recipe has inputs, find the binding constraint: `min(amount, stock_of_input / perUnit)` for every input.
4. Subtract inputs, add output to stock.

This is what makes multi-tier supply throttle naturally: when an input is missing, the output can't be made.

### Stockpile cap

```
productionScale(stock, target):
  scale = 1 below target
  scale = 0 above target × STOCKPILE_CAP_MULT
  linear taper between
```

`STOCKPILE_CAP_MULT = 3.0` — production falls to zero at 3× target stock. This is how Verdant's grain pile stops at 600 instead of growing to 6000.

A producer with no target (`targetStock[good]` undefined) has no cap — full rate forever. Generally you want a target.

## Traders (NPC ships)

A `Trader` holds:
- `capacity`, `speed` — cargo / movement scalars
- `fuelCapacity` — single-tank size
- `fuelTypes: { good, perDistance }[]` — preference-ordered list of fuels this ship can use
- `currentFuel: { good, qty } | null` — what's actually in the tank
- `funds`, `location`, `state: "idle" | "transit"`, `cargo`, `destination`, `ticksRemaining`

### Decision math

When idle, a trader:

1. **Refuels** if tank is below `REFUEL_THRESHOLD = 0.4` of capacity. Picks the highest-preference fuel that has stock locally. Switching fuels dumps the remaining incompatible fuel.
2. **Evaluates trade options** — for every (good, destination) pair from current location:
   - Filter by cargo capacity (`capacity / weight`)
   - Filter by source stock (won't drain more than `MAX_DRAW_FRACTION = 0.5` of available)
   - Filter by funds (can't buy what it can't pay for)
   - Filter by fuel availability for the trip
   - Filter by anti-stranding rule: only commits if either (a) destination has fuel for this ship's preferred type at refuel-threshold-or-better, or (b) ship will land with at least `STRANDING_RESERVE = 0.2` of capacity left
   - Compute `profitPerUnit = sellPrice - buyPrice - (fuelCost / qty)` where fuel cost is imputed at the *local* fuel price
   - Compute `profitPerTick = totalProfit / (travelTicks + 1)`
   - Skip if `profitPerTick < MIN_PROFIT_PER_TICK = 0.5`
3. **Picks the best option** by `profitPerTick`, buys the cargo, deducts fuel up front, departs.

If no option qualifies, emit `idle` (or `stuck` if fuel is too low to reach any neighbor — distinguishable for the future work board).

In transit: countdown ticks, on arrival sell cargo at destination's listed price. The buy/sell cycle is what redistributes goods and pulls prices toward equilibrium.

### Stability invariants on traders

- **Transit-only maintenance**: `capacity × MAINTENANCE_PER_CAPACITY = 0.5` per tick during transit, `× MAINTENANCE_IDLE_FACTOR = 0` when docked. A parked ship has zero operational cost. This was tightened from earlier values (1.5 transit, 0.4 idle) after observing a death-spiral: idle ships paid maintenance whether or not profitable trades existed, accumulating losses until they hit zero funds and got permanently stuck. With the current setup, ships that can't find a profitable trip simply sit and wait — no drain.
- **Trip-aware profit math**: `evaluateOptions` subtracts `travelTicks × capacity × MAINTENANCE_PER_CAPACITY` from total profit before deciding. Trader only commits to a trip if the *net* (after both fuel and maintenance) clears `MIN_PROFIT_PER_TICK = 0.05`. This ensures traders never take loss-making trips just because the gross looked positive.
- **Floor at zero funds**: a broke trader pays no maintenance and can't trade — frozen, emits `stuck` events. With the current constants this is rare; it remains as a safety net.

Verified across all scales (starter through 100 generated locations) and durations (200, 500, 1000, 2000 ticks): zero stuck traders. NPC fleet funds grow modestly but bounded; Tier 2 (docking fees + crew wages) will close the loop more tightly when player money joins the system.

## Goods catalog

15 goods across 6 categories:

| Category | Goods |
|---|---|
| food | grain, protein, vatmeat |
| raw | ore, polymer |
| intermediate | fiber, parts |
| luxury | xenospice, silk |
| fuel | plasma, antimatter |
| advanced (tier-2) | electronics, weapons, luxury_goods, medkits |

Tier-2 recipes always pull from tier-1+. Specifically:
- electronics = parts + antimatter (tech ≥ 7)
- weapons = parts + polymer (tech ≥ 6)
- luxury_goods = silk + xenospice + fiber (tech ≥ 5)
- medkits = protein + fiber (tech ≥ 4)

The chain is intentionally tight: Ironhold's parts production is shared between export demand and the local electronics+weapons recipes, so stressing the tier-1 chain visibly throttles tier-2.

## Starter universe

| Location | Tech | Tags | Position | Role |
|---|---|---|---|---|
| Haven Station | 6 | trade-hub, core, civilian | (0, 0) | Trade hub. Protein, fiber, medkits |
| Ironhold Belt | 8 | industrial, core, mining | (4, 0) | Heavy industry. Ore, parts, plasma, antimatter, electronics, weapons |
| Verdant Ring | 4 | agricultural, ring-habitat, core | (1, 3) | Farms. Grain, vatmeat, polymer |
| Saffron Rim | 5 | frontier, rim, luxury | (8, 8) | Frontier luxury. Xenospice, silk, luxury_goods |

Saffron emergently sits as the farthest port from everyone — its frontier character comes from geometry, not from a hand-tuned distance matrix.

6 starter NPC ships in `src/sim/data/traders.ts`. Pelican, Mantis, Kestrel, Mule are plasma-only basic ships. Falcon and Leviathan are antimatter-capable hybrids — these are the templates the player will eventually retrofit toward.

## Stability invariants (the load-bearing ones)

Any future change should preserve these unless explicitly intended:

1. **Per-unit price ∈ [0.25× base, 5× base]** for every good, every location, every tick. Enforced by the price clamp, tested in `pricing.test.ts`.
2. **Stockpile of any produced good ≤ 3× target** at every location. Enforced by `productionScale`, tested in `economy.test.ts`.
3. **Trader funds ≥ 0** always. Enforced by maintenance floor, tested.
4. **No tier-2 good is permanently starved everywhere** at steady state. Tested in `chains.test.ts`.
5. **Determinism** — same starting world, same N ticks, same final state. Tested in `tick.test.ts`.

If a change breaks one of these, it should be deliberate and documented.

## Testing

`npm test` runs ≈65 tests in ~0.3s. Coverage spans:

| Test file | What it covers |
|---|---|
| `pricing.test.ts` | Price curve invariants (clamp, monotonic, base-anchor) |
| `geometry.test.ts` | Distance derivation, lane modifiers, starter universe geometry |
| `tick.test.ts` | Tick counter, determinism, no-negative-stock, input gating |
| `traders.test.ts` | Trader convergence (shortage halved vs no-traders, profit, price flattening) |
| `fuel.test.ts` | Single-fuel basics + multi-fuel preference, fallback, switching |
| `economy.test.ts` | productionScale curve, stockpile bound, fund bound, broke-trader freeze |
| `locations.test.ts` | Net production helpers, trait queries, declared/derived export consistency |
| `chains.test.ts` | Tech-gated production, chain throttling, tier-2 steady-state bounds |

## The scenario harness

`npm run sim 500` runs 500 ticks and prints:
- Per-location stockpile and price for every good
- Trader status (location, state, cargo, funds)
- Total shortage volume and worst recurring shortages
- Trade count

This is the tuning workbench. When you change a constant in `economy.ts`, run the harness before and after to see the effect.

## World generation

`src/sim/gen/` contains a seeded archetype-based world generator. The hand-tuned starter universe is the default and the tutorial-friendly map; the generator is for stress-testing, future "new game" flows, and any time you want a bigger universe than 4 stations.

```ts
import { generateWorld } from "./gen/world";
const w = generateWorld({ seed: 42, locationCount: 50 });
```

5 location archetypes:
- `trade-hub` (tech 5–7, central placement)
- `mining-belt` (tech 6–8, conditionally produces antimatter at tech ≥7)
- `agricultural-ring` (tech 3–5, big population)
- `frontier-outpost` (tech 4–6, picks xenospice or silk)
- `research-station` (tech 7–10, electronics specialist)

3 trader classes (basic_hauler, fast_scout, antimatter_hybrid). Antimatter ships only spawn if the world has at least one antimatter producer.

`mulberry32` PRNG → same seed = identical world + identical tick history. Verified by `npm test`.

## Scale: trader anticipation

The trader's `evaluateOptions` uses the *anticipated arrival price* — the price they'd face when they arrive, given that other traders may already be heading to the same destination:

```
dstStockAtArrival = currentStock + INFLIGHT_WEIGHT × (cargo from other in-transit traders)
sellPrice         = priceFor(base, dstStockAtArrival, target)
```

`INFLIGHT_WEIGHT = 1.0`. The trader's *own* cargo is **not** subtracted — they actually receive the listed price at arrival; the price drop from their delivery is what the *next* trader would face. This was a subtle but important fix: counting own cargo made the trader treat themselves as if they were paying a future-trader's price, which killed perfectly profitable trades at small scale (a single ship dumping into an empty market saw a tiny anticipated price even though they'd really collect the high listed price).

`inTransitArrivalsByDestGood` is recomputed at the start of each trader step and updated as each trader commits, so within a tick traders also coordinate sequentially without explicit messaging — if A commits to ship grain to D this tick, B evaluating after A sees A's cargo as in-flight.

Effect: prevents extreme convergence at scale (multiple ships piling into one destination), without choking off legitimate small-scale arbitrage. Per-location-per-tick shortage stays around 11 across all scales.

## Benchmark

`npm run bench` runs the generator at increasing scales and reports ms/tick:

| Locations | Traders | ms/tick | ticks/sec |
|---|---|---|---|
| 10 | 15 | 0.18 | 5600 |
| 25 | 38 | 0.70 | 1430 |
| 50 | 75 | 1.9 | 530 |
| 100 | 150 | 8.1 | 123 |
| 200 | 300 | 29 | 34 |
| 500 | 750 | 139 | 7 |
| 1000 | 1500 | 480 | 2 |

`evaluateOptions` is `O(traders × goods × locations)` per tick, with early-exits making it sub-quadratic in practice. For real-time play with 1 tick/sec, ~200 locations is the comfortable ceiling. Beyond that, optimization paths exist (cache distances, K-nearest-neighbor consideration, typed arrays) but aren't yet needed.

Per-location-per-tick shortage rate stays remarkably consistent (~8–11 units) across all scales — the economy stays proportionally as functional at 1000 locations as at 10.
