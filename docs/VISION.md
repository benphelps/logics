# Vision

## What this game is

A **dense, spreadsheet-style** single-player browser game about running a fleet inside a **living market economy**. The economy is the protagonist. Ships, jobs, fuel, trade routes — everything else exists to give the player levers on the simulation.

Inspirations: Patrician, Port Royale, Offworld Trading Company, X-series. Setting: late-era / space.

## Pillars

### 1. The economy is the game

Prices, stockpiles, production rates, trader behavior — these are not flavor. They are what the player reads, predicts, and intervenes in. The sim must be tight enough to reward attention.

### 2. Numbers must be intelligible

A spreadsheet UI implies the player will look at hundreds of numbers per session. They have to mean something stable. The price of grain at hour 1 must be roughly the price of grain at hour 100, even after the player has gotten richer and the universe has grown more complex. **Scale, not drift.**

This is enforced today by:
- A clamped price curve (`0.25× – 5× base`) so per-unit prices physically can't escape a known band
- A stockpile cap on production so glutted producers stop manufacturing instead of accumulating forever
- City treasuries that close the money loop — every dollar in the sim belongs to either a trader or a city, and trade flows transfer between them. Combined with a per-tick wealth-carry on NPC traders, this caps NPC fleet growth at a stable plateau (verified across 50k+ ticks)
- A clamped share-price curve (`0.1× – 10× anchor`) on every listed equity so the equity layer can't drift either

The cost of these invariants is paid today (test surface, tuning). The benefit is paid forever (the late game stays readable).

### 3. Single player, deterministic, pause-able

Multiplayer was considered and explicitly deferred. Single-player lets the sim be deterministic, lets us model the entire economy in-browser without a backend, and avoids the "wait for the server tick" friction that kills a game built around studying numbers.

### 4. Sim is a pure module

`src/sim/` has no React imports. It runs headless under vitest and the scenario CLI. This means:
- Balance is testable. We can assert "after 500 ticks, no good is permanently starved everywhere" as a regression test.
- The economy can be tuned in isolation from the UI.
- The same sim code will eventually run on the server if multiplayer ever comes back.

### 5. Emergent over scripted

We prefer mechanisms that produce interesting behavior to scripted events that simulate it. Examples already in:
- Saffron Rim is a "remote frontier port" because it sits far in coordinate space. Trader stranding emerges naturally.
- Ironhold antimatter trickles outward only because traders carry it as fuel — there's no "spread antimatter" routine.
- Tier-2 production at Ironhold throttles when the parts-from-ore tier-1 chain throttles. Nobody wired this up; it falls out of the input-gating logic.

## What this game isn't

- **Not real-time-strategy**. No combat as a primary loop. (Escort jobs may have damage state, but combat is not the game.)
- **Not a city builder**. The player operates within stations, doesn't build them.
- **Not a roguelike or rogue-lite**. The world is persistent, prices are recoverable, you can't lose by bad luck in five minutes.
- **Not skinned forever**. The current era (space, antimatter, plasma fuel, station names) was committed to early but the sim is theme-agnostic — `polymer` and `parts` are commodity ids, not lore.

## The look (planned)

A **dense grid**. Think AG-Grid / TanStack Table — multiple sortable, filterable tables of: markets, ships, jobs, contracts, prices over time. No 3D, no cinematic camera, no NPC dialogue trees. The drama is in the columns.

A small map view may exist for spatial intuition (we have positions on locations now), but it's a sidebar, not the main act.

## What "late game" looks like (target)

- Player runs ~10–30 ships
- Player has retrofitted some ships to advanced fuel paths (antimatter today; later: more tiers)
- Player runs persistent contracts (subscribe to deliver X to Y on schedule, instead of one-off jobs)
- Player has reputation/standing with factions, modulating port access and prices
- Player holds a portfolio of station and syndicate equities, riding NPC arbitrage as a passive return stream alongside their own active trading
- The universe has grown — more locations, more goods, more chains — but a unit of grain still costs roughly what it cost on day one

The work to make late-game feel different is **adding scale**, not adding price inflation. New locations, new goods, new tiers, new ship classes, new contract types.

## The equity exchange

The economy has a second order on top of the goods market: every station and a handful of NPC syndicates are publicly-traded. The player can go long or short, set stop-loss / take-profit thresholds, and collect quarterly dividends from station treasury surplus. Share prices are clamped to a fixed band around an IPO anchor (no drift) and respond to underlying signals — treasury health for stations, fleet wealth + recent revenue for syndicates.

The exchange is the same idea as the goods market in spreadsheet form: dense numbers, stable bands, no scripted events. Watching a station's treasury deplete and shorting the listing before the price reflects it is the same kind of "alpha" as watching grain build up at Verdant and being there when the price drops.
