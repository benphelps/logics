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

1. **Refuels** if tank is below `REFUEL_THRESHOLD = 0.6` of capacity. Picks the highest-preference fuel that has stock locally. Switching fuels dumps the remaining incompatible fuel.
2. **Evaluates trade options** — for every (good, destination) pair from current location:
   - Filter by cargo capacity (`capacity / weight`); player ships also reserve space for accepted-contract goods at the destination available at this source
   - Filter by source stock (won't drain more than `MAX_DRAW_FRACTION = 0.5` of available; 1.0 for manual-piloted player ships)
   - Filter by funds (can't buy what it can't pay for)
   - Filter by fuel availability for the trip (uses `effectivePerDistance` so crew range modifiers apply)
   - Filter by anti-stranding rule: only commits if either (a) destination has fuel for this ship's preferred type at refuel-threshold-or-better, or (b) ship will land with at least `STRANDING_RESERVE = 0.3` of capacity left
   - Compute `profitPerUnit = sellPrice - buyPrice - (fuelCost / qty)` where fuel cost is imputed at the *local* fuel price; sell price is *net* (after `SALES_TAX_RATE = 0.15`)
   - Subtract `tripMaintenance` and `tripDockingFee` from the per-trip total
   - For player ships only: fold in accepted-contract `(reward + penalty) / qty` bonus on matching `(destination, good)` routes; for player ships in manual or auto + navigator, also fold in unaccepted shortage rewards
   - Compute `profitPerTick = totalProfit / (travelTicks + 1)`
   - Skip if `profitPerTick < MIN_PROFIT_PER_TICK = 0.05`
3. **Picks the best option** by `profitPerTick`, buys the cargo (player auto-pilot may pre-load contract goods first), deducts fuel up front, departs.

If no option qualifies, fall back to `listSpeculativeOptions` — empty trips to a via station that opens up a profitable trade. If neither fires, emit `idle` (or `stuck` if fuel is too low to reach any neighbor).

In transit: countdown ticks, on arrival sell cargo at destination's listed price. The buy/sell cycle is what redistributes goods and pulls prices toward equilibrium.

### Stability invariants on traders

- **Transit-only maintenance**: `capacity × MAINTENANCE_PER_CAPACITY = 0.5` per tick during transit, `× MAINTENANCE_IDLE_FACTOR = 0` when docked. A parked ship has zero operational cost. Maintenance is purely the cost of being in motion.
- **Docking fee**: `capacity × DOCKING_FEE_PER_CAPACITY = 5` charged on every arrival. Scales with activity (more trips = more fees) so it's self-correlated with the money creation that happens on sales.
- **Sales tax**: `SALES_TAX_RATE = 0.15` of every sale revenue is destroyed (treated as port tax). Trader receives 85% of the listed price.
- **Trip-aware profit math**: `evaluateOptions` subtracts both trip-maintenance (`travelTicks × capacity × MAINTENANCE_PER_CAPACITY`) and the docking fee (`capacity × DOCKING_FEE_PER_CAPACITY`) from total profit before deciding. Sell price in the math uses the *net* (after-tax) value. Trader only commits if `profitPerTick > MIN_PROFIT_PER_TICK = 0.05`.
- **Floor at zero funds**: a broke trader pays no maintenance and can't trade. With the current constants this is rare across 5000-tick runs at all scales.

Verified across starter / 10 / 50 / 100 generated locations and durations 200 / 500 / 2000 / 5000 ticks: **zero stuck traders, active trade, shortage rates 7-9 units/tick/loc**.

NPC fleet wealth still grows over very long runs because typical trades have positive markup (sales create slightly more money than purchases destroy). The 15% tax + docking fee dramatically slows this — fleet wealth roughly doubles every ~2000 ticks rather than growing 10× — but does not fully close the loop. Real loop closure (Tier 3) requires location treasuries that pay traders for sales out of a finite pool replenished by abstract local revenue. Deferred until needed; for now the slow growth is bounded enough that a play session won't see meaningful inflation.

## Player layer

Everything above is the NPC-driven economy. The player layer sits on top: a single player owns one or more ships, accepts contracts, hires crew, and either drives ships manually via the suggestion engine or hands them to the auto-pilot.

### Ship-funded model

Each ship is financially independent. **All player-side flows touch `trader.funds` on the relevant ship**, not a global bank:

- Hiring crew → `ship.funds -= hireCost`
- Repair → `ship.funds -= maintenanceDebt`
- Maintenance + crew wages each tick → drained from `ship.funds`
- Contract reward on delivery → `ship.funds += reward`
- Contract penalty on expire/abandon → `ship.funds -= penalty`

`world.player.funds` exists in the type but no sim flow reads or writes it (kept as a slot for a future personal-stash / inter-ship transfer feature). The starter ship spawns with **Ç55,000** at Haven Station.

### Crew

Three roles today (`captain`, `navigator`, `mechanic`). Mercenary is reserved for future combat work. NPC ships have no crew model — they operate with implicit captains. Crew is a player-only system.

`CrewMember { id, role, name, tier, hireCost, wagePerTick, modifiers }` — a snapshot from a hire offer, copied onto `ship.crew` when hired. `CrewModifiers` scaffolds eight stat-touching fields:

| Modifier | Wired |
|---|---|
| `cargoCapacityBonus`, `fuelCapacityBonus`, `speedBonus` | Yes — `recomputeShipStats` folds into effective stats |
| `rangeEfficiency` | Yes — read at every fuel calc via `effectivePerDistance` |
| `maintenanceDiscount` | Yes — applied in `chargeOperationalCosts` |
| `buyDiscount`, `sellPremium`, `contractRewardBonus` | Defined but not yet wired at trade/contract time |

Each ship has an effective `capacity` / `speed` / `fuelCapacity` plus an immutable `baseCapacity` / `baseSpeed` / `baseFuelCapacity`. `recomputeShipStats(ship)` runs after any hire/fire and idempotently rebuilds the effective stats from base + crew modifier sum.

#### Dynamic hire pool

Crew aren't a static roster — `world.hires: Record<HireId, Hire>` is a per-station pool that `generateHires(world)` populates each tick (deterministic per-`(loc, tick)` `mulberry32`, scaled by population × techLevel) and `expireHires(world)` clears past deadline. Capped at `HIRE_MAX_PER_STATION = 6`. Tier rolled by station tech (low-tech ≈ 85% T1, mid opens T2, high opens T3). Modifier values are deliberately small (caps: +2-6 cargo, +3-8 fuel, 3-10% percentages, 0-2 mods per hire). Cost = `(roleBaseline + Σ MOD_COST_WEIGHT × value) × tierMult`.

Role baselines (T1, no mods):
- Captain `Ç25,000` + `Ç4/t` wage
- Mechanic `Ç40,000` + `Ç3/t` wage
- Navigator `Ç140,000` + `Ç10/t` wage

Tuned so each role becomes affordable on roughly this timeline: captain within ~10 manual trades; mechanic shortly after (before the maintenance-debt grounding bites); navigator after a stretch of auto-trading has built up funds.

### Maintenance debt + repair

Player ships without a mechanic accumulate unpaid maintenance into `trader.maintenanceDebt`. Once `debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK = 8000`, `travelTo` refuses with a "repair ship before travel" error — the ship is grounded until cleared. `repairShip(world, ship)` charges `ship.funds -= debt` and resets the counter. With a mechanic, maintenance is auto-paid each tick (with the mechanic's `maintenanceDiscount` applied) and no debt accrues.

### Auto-pilot behavior, by crew composition

Player ships have `pilot: "manual" | "auto"`. NPCs always run the same auto-pilot; the player's auto behavior is gated by crew.

| Crew | Auto-pilot does | Doesn't do |
|---|---|---|
| **(none)** | Nothing — silent idle. The Auto button is disabled with a "Hire a captain to engage auto-pilot" tooltip. | Anything. |
| **Captain** | Refuels when below threshold. Picks the best `buy_for_route` from `listTradeOptions` and departs. Falls back to speculative empty trips when no local trade is profitable. Auto-sells everything on arrival (NPC parity). Maintenance accrues as debt. | Accept contracts. Pre-load anything alongside the primary buy. Pay maintenance automatically. |
| **Captain + Mechanic** | All captain behavior. Maintenance + wages auto-paid each tick (with the mechanic's discount). No debt. | Accept contracts. |
| **Captain + Navigator** | All captain behavior. **Auto-accepts** any unaccepted local shortage contracts on arrival whose good matches the cargo about to be sold (free credit). **Pre-loads contract goods** before the primary buy when a buy_for_route's destination matches an accepted contract for a different good — high-tier first, primary fills the remaining bay. Trade scoring **folds in** unaccepted shortage bonuses for any reachable contract destination (the navigator will follow through on arrival). Trade scoring **folds in** accepted-contract `(reward + penalty)/qty` bonus, so the engine treats abandoned contracts as real cost. | Auto-pay maintenance. |
| **Full crew (cap + nav + mech)** | All of the above. Fully autonomous. | — |

Refuel logic, anti-stranding reserve, speculative travel, multi-good loadout, and contract-aware route scoring all live in `traders.ts` regardless of crew — the captain "unlocks" them by enabling auto-pilot at all; the navigator/mechanic add the contract-acceptance and maintenance branches on top.

### Job board (contracts + rescues)

`world.jobs: Record<JobId, Job>` is a per-tick generated pool of work the player can opt into. Two kinds:

- **Shortage contracts** (`kind: "shortage"`): a station with stock-below-target on a consumed good posts a "deliver N of X" contract. **Location-gated** — only visible in the UI from that station (you have to physically dock to learn the local needs).
- **Rescue calls** (`kind: "rescue"`): an NPC trader stranded with no fuel ≥ 1 tick gets a rescue contract posted at their station (fuel + good + qty matching their tank). **Broadcast** — visible from any station.

Tier scales with severity (shortage: stock/target ratio; rescue: `stuckTicks` since stranding) and drives:

- **Reward**: `qty × basePrice × REWARD_MULT_BY_TIER` (low 1.6×, medium 2.5×, high 4.0×)
- **Penalty**: `reward × PENALTY_FRACTION_BY_TIER` (low 0, medium 25%, high 100% — "can't ignore")
- **Expiry**: `EXPIRY_TICKS_BY_TIER` (low 120t, medium 60t, high 30t)

`generateJobs(world)` runs each tick and posts new contracts up to `MAX_OPEN_JOBS = 24`. `expireJobs(world)` drops past-deadline entries; if the contract was accepted, the penalty is charged to the accepting ship's wallet. Acceptance, abandonment, and delivery flow through `acceptJob` / `abandonJob` / `creditJobOnDelivery` — all gated to player ships, all updating `ship.funds` and emitting log entries.

Inside `sellAtLocation`, every successful sell calls `creditJobOnDelivery(world, ship, location, good, qty)` which scans accepted contracts at that location/good (sorted by tier) and credits delivered units, paying out the reward and clearing the contract when satisfied. That same path fires from the auto-pilot's arrive-time sell loop.

### Suggestion engine (manual mode)

`getGuidedHint(world, ship)` returns a single best-next-step `GuidedHint` for the player to follow when piloting manually. The engine doesn't drive auto-pilot — it advises a human. Hint kinds:

- `buy_for_route` — buy good X here, fly to D, sell. Often paired with a contract bonus.
- `travel_to_sell` — you have cargo, fly to D for a better sell or to fulfill a contract there.
- `sell_here` — drop cargo at this station (may close a contract).
- `accept_job` — accept a contract first; the next-step hint will then guide the route.
- `refuel` — fuel low, top off (critical-flagged when below 15%).
- `speculate` — empty cargo, no profitable local trade — fly empty to a via station that opens up a trade.
- `wait` — nothing useful to do this tick.

Candidates are scored by expected value (revenue – cost basis – fuel – maintenance – docking, plus contract bonuses where realizable) and the top hint wins. A few overrides shape the choice:

- **Honor commitments**: if the player is at an accepted contract's destination with matching cargo and the sell-here value is positive, that `sell_here` is force-promoted to top.
- **Contract bonus folding for unaccepted shortages**: only counted when the player can actually realize them (manual mode, or auto + navigator).
- **Accepted-contract bonus uses `(reward + penalty)/qty`**: penalty-avoided is real cost, so the engine commits to fulfilling what the player committed to.
- **Cargo reservation**: when picking `buy_for_route`, the engine reserves cargo space for any accepted-contract good at the same destination available at the source. The recommended `qty` shrinks accordingly so the player can also load the contract good.
- **Pre-emptive refuel**: if the top hint would land critically low at a station without fuel, `refuel` overrides.

UI elements get a `HintTarget` describing what to highlight (specific buy/sell good, travel destination, accept-job row). The Suggested Buy button uses `target.buyQty` so clicking buys the engine's recommended amount, leaving room for the contract good — not bay-max.

### Per-ship action log

Every Trader has a capped `log: ShipLogEntry[]` (cap = 60 entries) of formatted action history: buy/sell/depart/arrive/refuel/stuck plus job-flavor entries (`job_accepted` / `job_completed` / `job_expired` / `job_abandoned`). Sim functions push entries directly — `executeTrade` / `buyAtLocation` / `sellAtLocation` / `refuelManual` / `travelTo` push their own emitted events; `stepTraders` funnels NPC + auto-pilot events at the end of the tick; `acceptJob` / `abandonJob` / `expireJobs` / `creditJobOnDelivery` push job-flavor entries with reward / penalty info baked in.

Display is reverse-chronological under the bridge: tick · kind · message. Tone (`good` / `bad` / `warn` / `info`) drives row color.

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
