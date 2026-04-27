# Roadmap

What's done, what's next, and the pile of things we've talked about and shelved on purpose. Update this as you go — losing a parked idea is worse than over-documenting one.

---

## Done

Listed in commit order. Each was scoped tight, landed with tests, and updated this doc.

| Commit theme | What landed |
|---|---|
| Project scaffold | Vite + React + TS, vitest, tsx for headless scenarios |
| Core sim types + world data | Goods, Locations, Markets, World; starter universe |
| Tick loop + price formation | `base × clamp((target/stock)^0.6, 0.25, 5)` |
| NPC arbitrage traders | Profit-per-tick scoring, transit countdown, MAX_DRAW_FRACTION |
| Test suite + scenario harness | vitest, `npm run sim` |
| Fuel as a real trader resource | Per-trip fuel cost, refuel logic, anti-stranding reserve |
| Era reskin: sea → space | Goods/locations/ships re-themed; ids changed alongside display names |
| Tier 1 economic stability | Maintenance + stockpile cap + funds floor |
| Multi-fuel system | Per-ship `fuelTypes` preference list; antimatter as premium fuel |
| Spatial coordinates | `position` on locations; derived distances; lane modifiers |
| Location traits | `traits: { techLevel, tags, faction? }`; `primaryExports/Imports` |
| Multi-tier supply chains | Tier-2 goods + `requiresTechLevel` gating |
| Design docs | This file, `VISION.md`, `SIM.md`, README rewrite |
| Programmatic world generation | Mulberry32 PRNG, 5 location archetypes, 3 trader classes, archetype-aware radial placement; `npm run bench` for scale stress |
| Trader anticipation logic | Anticipated arrival price using own + in-flight cargo prevents multi-trader convergence overshoot at scale |
| Death-spiral fix | Idle maintenance → 0; trip-aware profit math (subtracts trip maintenance from net). Fleets stay healthy across 200/500/1000/2000 ticks at all scales — zero stuck traders observed. |
| Anticipation fix | Anticipated arrival price now only counts *other* traders' in-flight cargo, not own. Trader actually receives the listed price at arrival; price drop from own delivery only affects future traders. Restored active trade across all scales. |
| Tier 2 sinks | Docking fee (5/cap per arrival) + sales tax (15%) bound NPC fleet wealth growth without re-triggering death spiral. Verified to 5000 ticks at all scales. Loop not strictly closed; Tier 3 (treasuries) handles that when needed. |
| Player ship + bridge UI | Single player-owned ship at Haven. Manual pilot via UI bridge: 2×2 station/ship/cargo/travel cards, market + local-contracts split, action log card, in-transit progress bar with quick-travel. Suggestion engine drives ✦ markers + row highlights. |
| Speculative travel | When no profitable local trade exists, NPCs + auto-pilot can fly empty to a nearby station that opens up a profitable trade. K=6 nearest cap. |
| Job board | `world.jobs` pool generated each tick. Two kinds: location-gated **shortage contracts** (visible only at the destination), broadcast **rescue calls** (NPCs stranded ≥ 1 tick). Tier scales with severity → `(reward, penalty, expiry)` triples. Reward credited on delivery via `creditJobOnDelivery` inside `sellAtLocation` and the auto-pilot's arrive-sell. Penalty charged on expiry/abandon. |
| Per-ship action log | Capped `Trader.log` of formatted entries (buy/sell/depart/arrive/refuel/stuck + job lifecycle). Surfaced as a card under the bridge. |
| Crew system + dynamic hire pool | Three roles (captain / navigator / mechanic). `world.hires` per-station pool with deterministic per-(loc, tick) generation, expiry, station-tech tier roll. Modifiers: cargo / fuel / speed / range wired today; buy / sell / contract % scaffolded. `recomputeShipStats` folds modifiers onto effective stats; `effectivePerDistance` for range. Each role gates a slice of auto-pilot behavior — see SIM.md auto-pilot table. |
| Maintenance debt + Repair Ship | Player ships without a mechanic accumulate unpaid maintenance. Past `MAINTENANCE_DEBT_TRAVEL_BLOCK = 8000` the ship can't depart until repaired. With a mechanic, auto-paid (with discount). |
| Ship-funded wallets | Each ship is financially independent: hire / repair / wages / maintenance / contract reward+penalty all touch `ship.funds`, not a global player bank. Initial ship spawns with Ç55,000. `world.player.funds` retired (kept in type at 0 for future personal-stash). |
| Contract-aware engine | `listTradeOptions` folds in unaccepted-shortage bonuses for player ships that can realize them (manual or auto+nav). Accepted-contract bonus uses `(reward + penalty)/qty` so commitment carries weight. `cargoLoadedCandidates` does the same for travel-to-sell. New remote-Case-A: when carrying a contract good, surface "Accept and head to X" as a candidate. Honor-commitments override force-promotes at-destination contract sells. Sell hint targets a specific good (not all cargo). |
| Auto-pilot multi-good loadout | `stepTrader` pre-loads accepted-contract goods (high-tier first) before the primary buy when a buy_for_route's destination matches an accepted contract for a different good. One trip, multiple contracts fulfilled. |
| Cargo reservation in `listTradeOptions` | When sizing the primary buy, the engine reserves cargo for accepted-contract goods at the same destination available at this source. Recommended `hint.qty` shrinks; the suggested Buy button uses it (not bay-max), leaving room for the contract good. |

---

## Queued (next up — sim layer)

These are the natural next steps that stay in the sim layer and can ship before the player exists.

### Tier 3 economic stability — location treasuries (closed money loop)
**Why deferred**: Tier 1 (stockpile cap + maintenance) and Tier 2 (docking fee + sales tax) together keep NPC fleet growth slow enough that no play session sees inflation. But typical trades have positive markup, so NPC fleet wealth still grows — just much more slowly. The loop is not strictly closed.
**Trigger to do**: when player wealth growth interacts with NPC growth in problematic ways (e.g., the player can't compete because NPCs have run away with the wealth), OR when very-long-running NPC-only sims hit price-clamps unexpectedly.
**Shape**: each location has a `treasury` balance. When trader sells goods at a location, the treasury pays them (treasury -= sale_price × qty); if treasury empty, sale falls back to floor price or refused. When trader buys, money goes INTO the source location's treasury. Treasuries replenish from a per-tick "local revenue" proportional to population. Money becomes strictly conserved system-wide.

### Population-driven consumption
Locations have `population` but it doesn't drive anything. Consumption rates are flat. Realistic: bigger pop = more grain consumed.
**Why not yet**: changes equilibria everywhere — would need rebalancing the whole starter universe. Worth doing alongside any major content addition (more locations).

### More tier-2 / tier-3 content
The recipe + tech-level + chain-throttling system supports arbitrary depth. Concrete tier-3 candidates that would make sense: research data, AI cores, exotic matter, terraforming kits. Each would require multiple tier-2 inputs.
**Why not yet**: don't add depth that has no consumer. Wait until the player exists and wants to pursue advanced production paths.

### Antimatter as cargo, not just fuel
Currently antimatter has no demand outside trader fuel use. A research-station consumer or weapon-recipe input would give it a real commodity market.
**Why not yet**: this is content, not mechanism. Slot it in when adding tier-3.

### Multi-hop trader planning
NPC traders only think one trip ahead. A smarter trader would chain "carry fuel to Saffron, pick up silk on the return, sell silk at Verdant." This emerges weakly today (subsequent trips at the destination are evaluated then) but isn't planned.
**Tradeoff**: smart traders are more efficient → less price spread → less arbitrage opportunity for the player. Probably leave NPC traders simple and let the player be the smart one.

---

## Queued (next up — game layer)

These cross from "sim that runs" to "game you play."

### Player ship + work board
The biggest jump. Player has 1+ ships they manually control. Jobs come from:
- `stuck` events from broke/stranded NPC traders → "Rescue stranded ship" contracts
- Persistent shortages → "Deliver N grain to Saffron" contracts
- Faction politics → escort, smuggling, diplomatic missions
**Foundations already in**: `stuck` events fire today; `locationsImporting(world, good)` lists shortage-prone ports.

### First UI screen
Single dense market table — locations down, goods across, with stock/price cells. Sortable, filterable. The MVP visual sanity check before more screens.
**Stack picked**: Vite + React + TanStack Table + Zustand. Vite/React already scaffolded. TanStack/Zustand installed.

### Ship traits / upgrades scaffolding
Generalize the multi-fuel `fuelTypes` pattern: ship has slotted modules (engine, hull, cargo bay, sensors, life support). Each module has stats; player visits a shipyard to upgrade. Multi-fuel is already an example — `fuelTypes` swap is exactly the upgrade flow.
**Why not yet**: needs UI to be useful. Slot on top of player layer.

---

## Discussed and parked

Things we've talked about but decided to defer or not pursue.

### Multiplayer
**Decided against** for now. Single-player keeps the sim deterministic, runs entirely in the browser, no backend, no anti-cheat, pause-able. Adding multiplayer later is possible — sim is a pure module that could run on a server tick — but design assumes single-player.

### `security` trait on locations
Mentioned but not added. The principle: don't add traits without a reader. Add when the work board needs to drive escort job demand from low-security ports.

### Spoilage / perishable goods
Mentioned in passing. Would create natural "deliver fast" pressure for food goods. Not added — current stockpile cap already handles unbounded growth. Could be a content lever later for specific goods (vatmeat decays at +5%/tick beyond target stock?).

### Population growth
Currently static. Long games could grow stations (more pop = more consumption = more demand). Out of scope until late-game progression matters.

### Save / load
Not yet. Sim is a serializable plain object (`World` is just data + functions are stateless). `JSON.stringify(world)` should round-trip; will need a small reviver for any future class instances. Trivial to add when needed.

### Time / calendar
Currently just an integer `tick`. No day/week/season concept. Could add for content that varies (harvest seasons, faction events). Defer until content needs it.

### Procedural universe generation
The sim is data-driven enough to support it (drop in a generated `LOCATIONS` map + `GOODS` map and `createWorld` does the rest). Not built. Could be a "new game" flow when the game has any of those.

### Combat / ship damage
Implied by escort jobs but not modeled. Needs: hull/shields stats, damage events, repair cost. Big surface area; defer until escort jobs justify it.

### Reputation / faction standing
The `faction` trait exists. Reputation is the consumer that doesn't yet exist. Defer until faction matters (port access, prices, mission availability).

### Mid-transit ship positions for the UI
Ships in transit currently track only `ticksRemaining` and `destination`. To draw a moving ship on a map, we'd interpolate from origin position to destination position by `1 - ticksRemaining/totalTicks`. Cheap to add when the UI wants it. Mentioned in the spatial-coordinates commit message.

### Hazardous lanes / jump lane content
The `lanes` modifier system is in. No content uses it. Natural fit for: rim routes are slower (×1.5), known jump lanes between core systems are faster (×0.6), pirate-infested routes need escort or a risk premium.

### A "balance sweep" tuning script
Not built. Would sweep one constant (e.g. `MAINTENANCE_PER_CAPACITY`) over a range, run scenarios, report steady-state shortage and fund-growth metrics for each. Turns balancing from guesswork into search. Worth building when manual tuning gets tedious.

### Performance optimization beyond ~200 locations
Current bench shows ms/tick goes 1.9 → 29 → 480 from 50 → 200 → 1000 locations. Sub-quadratic but not great. Known levers (none implemented):
- **Cache distances**: precompute the L×L distance matrix once at world creation. `distance()` is called O(traders × locations) times per tick.
- **K-nearest-neighbor consideration**: each trader only evaluates the K closest destinations instead of all of them. Loses some long-distance arbitrage but realistic.
- **Index goods by category**: traders could skip evaluating goods their ship "doesn't typically carry."
- **Typed arrays for stocks/prices**: replace `Record<GoodId, number>` with a flat `Float64Array` indexed by good index. Cache-friendly.

Worth doing when targeting 500+ locations or when player feedback says ticks feel slow.

### Fuel weight as cargo cost
Currently cargo capacity is independent of fuel tank capacity. Realistic: fuel takes physical space. Not modeled because it'd require redesigning the capacity math. Probably never — game fiction wins over realism here.

### Multiple fuel tiers beyond plasma/antimatter
Mentioned. The data model supports an arbitrary `fuelTypes` list. Endgame "exotic matter" or "dark plasma" fits naturally. Add when there's a player progression to gate it behind.

### Antimatter-only ships
Specialized vessels that can't fall back to plasma. Possible with current data model — just don't include plasma in `fuelTypes`. Risk: very tied to one refuel port. Interesting design knob; not a priority.

### A "rescue stranded trader" contract type
Came up multiple times — the broke + stuck trader is a perfect work-board hook. Implementation is trivial once a work board exists: scan for `funds=0 AND state="idle"` traders and emit a job to deliver fuel + small subsidy. This is the cleanest "Tier 0" job to ship when the player layer lands.

---

## Invariants we should never silently break

These are baked into the sim and the test suite. If a change breaks one, the change should be deliberate and the relevant test updated with reasoning, not just adjusted to pass.

1. **Per-unit price ∈ [0.25× base, 5× base]** — `pricing.test.ts`
2. **Stockpile of any produced good ≤ 3× target** — `economy.test.ts`
3. **Trader funds ≥ 0 always** — `economy.test.ts`
4. **No tier-2 good permanently starved at every location** — `chains.test.ts`
5. **Sim is deterministic** — `tick.test.ts`
6. **Declared `primaryExports`/`primaryImports` consistent with production data** — `locations.test.ts`

Adding new invariants is encouraged. Removing one without a written reason should feel uncomfortable.

---

## Tuning constants worth knowing

Most balance levers are exported constants. Search for them:

| File | Constant | Effect |
|---|---|---|
| `pricing.ts` | `PRICE_ELASTICITY` | Steepness of price response to stock vs target |
| `pricing.ts` | `PRICE_FLOOR_MULT` / `PRICE_CEILING_MULT` | The unbreakable price band |
| `economy.ts` | `MAINTENANCE_PER_CAPACITY` | Per-tick fund drain on traders during transit (currently 0.5) |
| `economy.ts` | `MAINTENANCE_IDLE_FACTOR` | Multiplier for docked ships (currently 0 — parked is free) |
| `economy.ts` | `DOCKING_FEE_PER_CAPACITY` | One-time fee on every arrival (currently 5) |
| `economy.ts` | `SALES_TAX_RATE` | Fraction of every sale destroyed as port tax (currently 0.15) |
| `economy.ts` | `STOCKPILE_CAP_MULT` | Production tapers to zero at this × target |
| `traders.ts` | `MIN_PROFIT_PER_TICK` | Minimum margin a trader will accept after subtracting fuel + maintenance (currently 0.05) |
| `traders.ts` | `MAX_DRAW_FRACTION` | Cap on how much of a market a single trader can drain in one trip |
| `traders.ts` | `REFUEL_THRESHOLD` | Tank fraction below which refuel triggers |
| `traders.ts` | `STRANDING_RESERVE` | Minimum fuel reserve to not get stuck after arrival |
| `traders.ts` | `INFLIGHT_WEIGHT` | How much in-flight cargo from other traders counts in arrival-price anticipation (1.0 = full) |
| `traders.ts` | `SPECULATIVE_NEAREST_K` | Cap on candidate via-points considered per speculative-travel call (currently 6) |
| `crew.ts` | `MAINTENANCE_DEBT_TRAVEL_BLOCK` | Maintenance debt at which a ship without a mechanic is grounded (currently 8000) |
| `hires.ts` | `HIRE_MAX_PER_STATION` | Cap on concurrent posted hire offers per station (currently 6) |
| `hires.ts` | `HIRE_BASE_POST_CHANCE` | Per-station per-tick chance of posting a new offer (scaled by population × techLevel) |
| `hires.ts` | `BASE_HIRE_BY_ROLE` / `BASE_WAGE_BY_ROLE` | Tier-1 baseline pricing for each role |
| `hires.ts` | `MOD_RANGE` / `MOD_COST_WEIGHT` | Modifier roll envelope and pricing per modifier |
| `jobs.ts` | `MAX_OPEN_JOBS` | Cap on concurrent open contracts world-wide (currently 24) |
| `jobs.ts` | `REWARD_MULT_BY_TIER` / `PENALTY_FRACTION_BY_TIER` / `EXPIRY_TICKS_BY_TIER` | Per-tier reward × base-price scaling, penalty as fraction of reward, contract deadline window |
| `jobs.ts` | `SHORTAGE_HIGH_FRACTION` / `SHORTAGE_MED_FRACTION` / `SHORTAGE_LOW_FRACTION` | Stock/target thresholds that classify shortage tier |

Tuning workflow: change a constant → `npm test` (ensure invariants hold) → `npm run sim 500` (eyeball the steady state).
