# Roadmap

What's done, what's next, and the pile of things we've talked about and shelved on purpose. Update this as you go — losing a parked idea is worse than over-documenting one.

---

## Current direction

Ledgway is moving toward a public-facing browser game about space trucking, fleet coordination, and market speculation. The first loop is intentionally direct: control one ship, buy goods, move them between stations, sell into demand, and take contracts. The long loop is staged delegation: unlock guidance, hire a navigator, hire a mechanic, hire a pilot, upgrade the ship, and eventually hand routine work to a crew while the player moves on to larger ships, more ships, and higher-risk market decisions.

The app should keep that promise clear:

- **My Fleet** is the hands-on trucking screen.
- **Exchange** is the Wall Street layer on top of the same simulated economy.
- **Markets** is the commodity pressure board.
- **Atlas** is the route, station, ship, and future danger map.
- **Charters** is the career-progress surface for staged unlocks.

Future additions should reinforce that progression: multi-ship ownership, shipyard purchases, bigger hulls with traits, route danger, dangerous jobs, weapon modules with real combat consequences, and crews that generate income while the player coordinates the next tier of work.

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
| Tier 3 stability — location treasuries | Closed money loop. Each `MarketState` has a `treasury` + `treasuryTarget`. Sells withdraw, buys deposit, sales tax + docking fee stay in treasury. Per-tick replenishment from population (with soft taper above target). NPC wealth carry (0.08%/tick) feeds back into treasuries — caps fleet growth at a stable equilibrium. **Verified across 50k ticks**: NPC fleet wealth growth dropped from 200× → 4–8×; treasury totals bounded. Operating-float bailout is now treasury-funded (no money creation). See `docs/AUDIT_REPORT.md`. |
| Equity exchange | Stations + N NPC syndicates as publicly-traded equities with anchor-clamped prices `[0.1×, 10×]`, 1% broker fee, quarterly dividends from treasury surplus. Long + short positions per equity, weighted-average entry, per-position stop-loss / take-profit thresholds checked every tick (recorded as `STOP` / `TAKE` triggers in the trade ledger). Funding-aware short cap (no trapped shorts on a depleted underlying). `abandonPosition` escape hatch with 5% penalty. Player portfolio + 200-entry capped trade ledger. Save migration backfills equities/syndicates/positions for older save slots. |
| Exchange UI tab | Three left-side panels (Tape / Positions / Trades) + narrow sidebar with company info + entry actions. Click a position → that row becomes the only entry shown and surfaces inline risk-level inputs (with quick-fill 2/5/10% adverse and 5/10/20% favorable chips), close-side controls (Sell / Cover), and Abandon. Click again → back to the full list. Auto-closes (manual or trigger-fired) clear focus and return to the list naturally. |
| Long-horizon audit harness | `npm run audit [ticks]` exercises starter / 12-loc / 50-loc universes, reports trader funds, treasury balances, total system money, trade volume, stuck/broke fractions, invariant violations, and stock-market price-band utilization. Run before/after any economy-touching change. |
| Player ship + bridge UI | Single player-owned ship at Haven. Manual pilot via UI bridge: 2×2 station/ship/cargo/travel cards, market + local-contracts split, action log card, in-transit progress bar with quick-travel. Suggestion engine drives ✦ markers + row highlights. |
| Speculative travel | When no profitable local trade exists, NPCs + auto-pilot can fly empty to a nearby station that opens up a profitable trade. K=6 nearest cap. |
| Job board | `world.jobs` pool generated each tick. Two kinds: location-gated **shortage contracts** (visible only at the destination), broadcast **rescue calls** (NPCs stranded ≥ 1 tick). Tier scales with severity → `(reward, penalty, expiry)` triples. Reward credited on delivery via `creditJobOnDelivery` inside `sellAtLocation` and the auto-pilot's arrive-sell. Penalty charged on expiry/abandon. |
| Per-ship action log | Capped `Trader.log` of formatted entries (buy/sell/depart/arrive/refuel/stuck + job lifecycle). Surfaced as a card under the bridge. |
| Crew system + dynamic hire pool | Three roles (captain / navigator / mechanic). `world.hires` per-station pool with deterministic per-(loc, tick) generation, expiry, station-tech tier roll. Modifiers: cargo / fuel / speed / range wired today; buy / sell / contract % scaffolded. `recomputeShipStats` folds modifiers onto effective stats; `effectivePerDistance` for range. Each role gates a slice of auto-pilot behavior — see SIM.md auto-pilot table. |
| Maintenance debt + Repair Ship | Player ships without a mechanic accumulate unpaid maintenance. Past `MAINTENANCE_DEBT_TRAVEL_BLOCK = 8000` the ship can't depart until repaired. With a mechanic, auto-paid (with discount). |
| Ship-funded wallets | Each ship is financially independent: hire / repair / wages / maintenance / contract reward+penalty all touch `ship.funds`, not a global player bank. Initial ship spawns with Ç55,000. `world.player.funds` retired (kept in type at 0 for future personal-stash). |
| Contract-aware engine | `listTradeOptions` folds in unaccepted-shortage bonuses for player ships that can realize them (manual or auto+nav). Accepted-contract bonus uses `(reward + penalty)/qty` so commitment carries weight. `cargoLoadedCandidates` does the same for travel-to-sell. New remote-Case-A: when carrying a contract good, surface "Accept and head to X" as a candidate. Honor-commitments override force-promotes at-destination contract sells. Sell hint targets a specific good (not all cargo). |
| Auto-pilot multi-good loadout | With a navigator, `stepTrader` pre-loads accepted-contract goods (high-tier first) before the primary buy when a buy_for_route's destination matches an accepted contract for a different good. One trip, multiple contracts fulfilled. |
| Cargo reservation in `listTradeOptions` | When sizing the primary buy for manual guidance or auto+navigator, the engine reserves cargo for accepted-contract goods at the same destination available at this source. Recommended `hint.qty` shrinks; the suggested Buy button uses it (not bay-max), leaving room for the contract good. |
| Single-page website + logo | Added `website.html` with a standalone React/CSS site that presents Ledgway as a space logistics trading idle clicker. Added compact SVG logo assets in `public/site/` and captured live gameplay screenshots into `public/site/screenshots/`. |
| Expanded Exchange instruments | Exchange now covers station shares, syndicates, commodity spot listings, station basis pairs, futures contracts, and indices, with order books, positions, orders, futures P&L, history, settlement handling, and navigator trade insights. |
| Ship upgrades as real cargo/modules | Station upgrade stock, carried module goods, install/remove/replace flows, slot-specific effects, and shared crew/upgrade modifiers are in the player loop. |
| Save slots + app shell | Local save slots, autosave status, new game/load/delete controls, developer state, per-tab scroll memory, and the five-tab app shell are in the UI. |
| Career charters + staged unlocks | Manual-action milestones now gate upgrade tiers and crew offer pools. The Charters tab shows what is cleared, what is next, and how close the player is to the next unlock. |

---

## Queued (next up — sim layer)

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

## Queued (next up — game/app layer)

These are the next steps for turning the current sim-heavy build into a more public player-facing app.

### Public onboarding and first-session clarity
The opening session should sell the core loop without a tutorial wall: the player sees one good move, takes it, sees the wallet/cargo/fuel change, and understands why the next route matters.

Needed:
- better first-run copy and empty states
- clearer "why this action is suggested" language
- route profit and expected travel cost surfaced near the action
- tighter pacing around the first navigator/mechanic/pilot unlocks

### Multi-ship ownership
The UI already has a selected-ship picker and the save model stores `player.shipIds`, but the player still needs a real way to buy, name, switch, and retire ships.

Needed:
- shipyard offers or station-listed hulls
- transfer or funding rules between ships
- per-ship route/crew summaries in My Fleet
- fleet-level income and idle-progress readouts

### Bigger ships and hull traits
Current upgrades modify one starting hull. The next progression step is buying whole new ships with built-in traits: scout, courier, tanker, freighter, hauler, combat escort, and specialty exchange/logistics vessels.

Needed:
- hull catalog and purchase rules
- trait surface in the ship picker and info card
- route constraints that make different hulls matter
- migration path from starter ship to larger fleets

### Automation readability
Crew-gated auto-pilot works, but players need a better way to supervise it. The goal is not hidden AI magic; it is readable delegation.

Needed:
- per-ship "current plan" and recent profit summary
- clearer stuck/blocked auto states
- route earnings per tick
- fleet exception queue for ships needing player attention

### Route danger and dangerous work
Danger should add tension to trucking routes without turning Ledgway into an RTS. It belongs in lanes, jobs, ship stats, crew decisions, and insurance-like market consequences.

Needed:
- danger rating on lanes and Atlas filters
- dangerous contracts with higher reward and real failure risk
- hull/weapon checks during route resolution
- repair, damage, and loss outcomes that can be reasoned about

### Weapon upgrades with real consumers
Weapons already exist as upgrade slots and stats, but they do not yet affect route outcomes. Do not add more weapon content until there is a route-danger reader.

Needed:
- route combat/danger resolution
- weapon power contribution
- job types that pay for risk mitigation
- UI language that keeps combat secondary to logistics

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

### Cloud / account save
Local browser save slots are in. Account-backed cloud save is still out of scope because the project currently has no backend and benefits from staying deterministic and local-first.

### Time / calendar
Currently just an integer `tick`. No day/week/season concept. Could add for content that varies (harvest seasons, faction events). Defer until content needs it.

### Procedural universe selection
Programmatic world generation exists for scenarios and benchmarks. A player-facing "new universe" flow is still parked until the core game has enough content variety for world selection to matter.

### Combat as a primary loop
Route danger, dangerous jobs, hull damage, and weapon checks are planned. Direct combat as a primary minute-to-minute loop is still deferred; the game should remain about logistics and coordination first.

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

### Expanded rescue and service jobs
Basic rescue calls are implemented. Parked ideas include towing, repair dispatch, fuel subscriptions, escort variants, and station service contracts that need stronger route-danger and multi-ship support first.

---

## Invariants we should never silently break

These are baked into the sim and the test suite. If a change breaks one, the change should be deliberate and the relevant test updated with reasoning, not just adjusted to pass.

1. **Per-unit price ∈ [0.25× base, 5× base]** — `pricing.test.ts`
2. **Stockpile of any produced good ≤ 3× target** — `economy.test.ts`
3. **Trader funds ≥ 0 always** — `economy.test.ts`
4. **Treasury ≥ -2× target always; payouts capped at floor** — `treasury.test.ts`
5. **NPC fleet wealth growth ratio ≤ ~10× at 10k ticks** — `treasury.test.ts`
6. **No tier-2 good permanently starved at every location** — `chains.test.ts`
7. **Share price ∈ [0.1× anchor, 10× anchor]** — `stock.test.ts`
8. **Sim + stock market both deterministic** — `tick.test.ts`, `treasury.test.ts`, `stock.test.ts`
9. **Declared `primaryExports`/`primaryImports` consistent with production data** — `locations.test.ts`

Adding new invariants is encouraged. Removing one without a written reason should feel uncomfortable.

---

## Tuning constants worth knowing

Most balance levers are exported constants. Search for them:

| File | Constant | Effect |
|---|---|---|
| `pricing.ts` | `PRICE_ELASTICITY` | Steepness of price response to stock vs target |
| `pricing.ts` | `PRICE_FLOOR_MULT` / `PRICE_CEILING_MULT` | The unbreakable price band |
| `economy.ts` | `MAINTENANCE_PER_CAPACITY` | Per-tick fund drain on traders during transit (currently 0.5). Destroyed (real sink). |
| `economy.ts` | `MAINTENANCE_IDLE_FACTOR` | Multiplier for docked ships (currently 0 — parked is free) |
| `economy.ts` | `DOCKING_FEE_PER_CAPACITY` | Per-arrival fee (currently 5). Flows to local treasury (closed loop). |
| `economy.ts` | `SALES_TAX_RATE` | Fraction of every sale withheld by the treasury as tax (currently 0.15) |
| `economy.ts` | `STOCKPILE_CAP_MULT` | Production tapers to zero at this × target |
| `economy.ts` | `TREASURY_PER_POPULATION` | Initial treasury size + replenish target per resident (150) |
| `economy.ts` | `TREASURY_REPLENISH_PER_POP_PER_TICK` | Per-tick replenishment per resident (0.035) |
| `economy.ts` | `TREASURY_HAIRCUT_FLOOR` | Minimum sale-price multiplier even at depleted treasury (0.50) |
| `economy.ts` | `TREASURY_FLOOR_FRACTION` | Hard cap on treasury debt (-2.0 × target) |
| `economy.ts` | `NPC_WEALTH_CARRY_PER_TICK` | Per-tick wealth fraction NPCs pay to local treasury (0.0008) |
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
| `stock.ts` | `SHARE_PRICE_FLOOR_MULT` / `SHARE_PRICE_CEILING_MULT` | Hard clamp on equity price vs IPO anchor (0.1 / 10.0) |
| `stock.ts` | `SHARE_PRICE_SMOOTHING` | EMA blend rate toward fundamental (0.10 — sticky) |
| `stock.ts` | `SHARE_PRICE_NOISE` | Per-tick deterministic noise on share prices (0.0025) |
| `stock.ts` | `BROKER_FEE_RATE` | Fee on every share trade leg (0.01) |
| `stock.ts` | `DIVIDEND_INTERVAL` / `DIVIDEND_PAYOUT_FRACTION` | Ticks between dividends (200) and surplus fraction paid (0.05) |
| `stock.ts` | `SHORT_BORROW_RATE_PER_TICK` | Per-tick borrow fee on short notional (0.0001) |
| `stock.ts` | `TRADE_LEDGER_MAX` | Capped player trade history (200 entries) |
| `stock.ts` | `ABANDON_PENALTY_RATE` | Penalty applied when force-closing a trapped position (0.05) |

Tuning workflow: change a constant → `npm test` (ensure invariants hold) → `npm run sim 500` (eyeball the steady state) → `npm run audit 25000` (long-horizon stability).
