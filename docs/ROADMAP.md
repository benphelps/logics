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

---

## Queued (next up — sim layer)

These are the natural next steps that stay in the sim layer and can ship before the player exists.

### Tier 2 economic stability — docking fees + crew wages
**Why deferred**: Tier 1 already keeps prices stable; Tier 2 is about closing the money loop more tightly. It only matters once player wealth enters the system.
**Trigger to do**: when player money joins NPC money in the same pool, OR when scenario runs > 5000 ticks show NPC fund growth becoming a tuning headache.
**Shape**: per-arrival docking fee (scales with port size), per-tick crew wages (scales with ship size beyond capacity). Tune all sinks together so NPC traders break even on average.

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
| `economy.ts` | `MAINTENANCE_PER_CAPACITY` | Per-tick fund drain on traders |
| `economy.ts` | `MAINTENANCE_IDLE_FACTOR` | Discount for docked ships |
| `economy.ts` | `STOCKPILE_CAP_MULT` | Production tapers to zero at this × target |
| `traders.ts` | `MIN_PROFIT_PER_TICK` | Minimum margin a trader will accept |
| `traders.ts` | `MAX_DRAW_FRACTION` | Cap on how much of a market a single trader can drain in one trip |
| `traders.ts` | `REFUEL_THRESHOLD` | Tank fraction below which refuel triggers |
| `traders.ts` | `STRANDING_RESERVE` | Minimum fuel reserve to not get stuck after arrival |
| `traders.ts` | `INFLIGHT_WEIGHT` | How much in-flight cargo from other traders counts in arrival-price anticipation (1.0 = full) |

Tuning workflow: change a constant → `npm test` (ensure invariants hold) → `npm run sim 500` (eyeball the steady state).
