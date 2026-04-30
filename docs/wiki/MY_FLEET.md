# My Fleet

My Fleet is the player's operations screen. It is where each ship is managed as an independent business: every ship has its own wallet, cargo hold, fuel tank, crew, upgrades, contracts, and route state.

The current game starts with the player ship `Voyager`: 60 cargo capacity, 60 plasma fuel, speed 1, hull 3, and Ç55,000 in the ship wallet. `world.player.funds` exists for compatibility, but the active economy uses ship wallets.

## Screen Layout

The tab is built around one selected ship at a time:

- Top controls select the game, tab, speed, and current ship.
- The upper-left ship card shows fuel, hull damage, cargo, upgrades, and crew.
- The upper-right station card shows reachable destinations and travel controls.
- The lower-left station exchange card shows local markets, station modules, hire offers, and contracts.
- The lower-right info card explains the selected ship, station, or good.

Most rows can be hovered or clicked. Hovering previews information in the info card. Clicking pins that entry so it stays visible while you inspect another table.

## Top Controls

### Game Menu

The save menu shows the current game name, autosave state, tick, fleet value, and save slots. From here the player can save now, create a new game, load another slot, delete saves, reset the current game, or load the developer state.

### Main Navigation

The main tab buttons are:

- **My Fleet**: ship operations and automation.
- **Exchange**: station, syndicate, commodity, basis, futures, and index trading.
- **Markets**: commodity logistics and supply/demand reading.
- **Atlas**: stations, route planning, and ship positions.

### Tick And Speed

The game advances in ticks. The speed control can pause, step a single tick, or run at 1x, 4x, or 16x. Quick Travel on an in-transit ship advances exactly the remaining travel ticks for that ship.

### Ship Picker

The ship picker selects the controlled ship. It shows:

- ship name and state (`docked` or in transit)
- selected ship wallet
- total fleet wallet value
- current station or destination

Pilot mode is per ship. **Manual** means the player clicks actions. **Auto** lets crew run the ship, but auto-pilot needs a captain before it actually trades.

In Auto mode, most dockside action buttons become read-only because the ship's crew owns the trading loop. Switch back to Manual when you want to directly buy, sell, accept, hire, install, refuel, repair, or depart.

## Ship Card

### Fuel

The fuel meter shows tank percentage and current fuel type. Clicking it refuels when the ship is docked, manual, has compatible station fuel, has tank room, and can afford the fuel.

Fuel rules:

- Travel burns fuel up front when the ship departs.
- Fuel needed is route distance times the active fuel type's `perDistance`, adjusted by range modifiers.
- If a ship has a fuel-free upgrade modifier, travel requires no fuel.
- Refueling fills the compatible fuel type available at the current station. If the station sells a different compatible fuel than the tank currently holds, refueling switches the tank to that fuel type.

Fuel UI tones:

- below 15% is critical
- up to 30% is low
- up to 50% is draining/warning

### Hull Damage And Repairs

Hull Damage is the UI name for unpaid maintenance debt. Player ships without a mechanic accrue maintenance debt. When debt reaches `MAINTENANCE_DEBT_TRAVEL_BLOCK` (currently Ç8,000), the ship cannot depart until repaired.

Repair rules:

- The ship must be docked.
- Repair cost equals the current maintenance debt.
- Repair is paid from the ship wallet.
- A mechanic prevents debt from accumulating by paying maintenance automatically, with any maintenance discount applied.

### Cargo Tab

Cargo lists all goods currently in the hold.

Columns:

- **Good**: the cargo good. Click it to pin a trade helper.
- **Qty**: total units on the ship, including any units currently unloading.
- **P&L**: profit or loss if sold at the focused station's net sell price.
- **Action**: Sell, when the ship is docked and manual.

Cargo lots keep their own source station, unit price, and purchase tick. The UI folds lots into a weighted average for P&L, but the trade helper can show lot history.

Selling does not instantly dump cargo into the station. Sold cargo moves into an unloading state and drips into the market over `UNLOAD_TICKS` (currently 4 ticks). Unloading cargo still occupies hold mass until it finishes, cannot be sold again, and blocks departure.

### Upgrades Tab

Upgrades are ship modules that behave like cargo goods until installed. The tab has two parts:

- installed module slots
- upgrade modules currently carried in cargo

Current module slots include cargo, engines, fuel tanks, hull, weapons, and ship systems. Installing a module applies its modifiers to the ship through the same modifier system used by crew.

Common modifier types:

- cargo capacity
- fuel capacity
- speed
- hull
- weapon power
- fuel efficiency
- unload speed or instant unload
- instant travel or fuel-free travel
- maintenance discount
- exchange settlement collection
- buy, sell, contract reward, docking, yield, and dividend effects where relevant

For the full catalog, see [`UPGRADES_AND_CREW.md`](UPGRADES_AND_CREW.md).

Upgrade rules:

- The ship must be docked to install, remove, or replace modules.
- Installing from cargo consumes one matching module good.
- Replacing a module moves the old module into cargo at the current station.
- Removing a module moves it into cargo.
- An install or remove is rejected if the resulting cargo mass would exceed ship capacity.
- Cargo modules can also be sold from this tab.

### Crew Tab

Crew has three current roles:

- **Pilot** (`captain` in the sim): unlocks auto-pilot trading.
- **Navigator**: unlocks guided hints and highlighted next actions in My Fleet.
- **Mechanic**: auto-pays maintenance and prevents maintenance debt.

Each crew member has a tier, hire cost, wage per tick, and modifiers. Firing a crew member stops future wages but gives no refund. The ship must be docked to fire crew.

For crew offer generation, tiers, and modifier tables, see [`UPGRADES_AND_CREW.md`](UPGRADES_AND_CREW.md).

## Stations And Travel

The Stations card lists the current station and reachable destinations from the ship's current location. Each row shows:

- destination station
- distance
- fuel needed
- travel time in ticks
- active contract notes for that destination
- Depart action when available

Travel rules:

- The ship must be docked and not unloading.
- The route must exist.
- The ship must have enough compatible fuel unless it ignores fuel.
- Maintenance debt must be below the grounding threshold.
- Travel time is `ceil(distance / speed)`, unless an instant-travel modifier applies.

If a suggested action is still pending at the current station, clicking an off-route Depart button arms a confirmation instead of leaving immediately. This prevents accidental departures before buying, selling, refueling, repairing, or accepting a suggested contract.

While in transit, the same card becomes the Arrival route view. Quick Travel advances the game by the ship's remaining travel ticks.

## Station Exchange Card

The station exchange card is the dockside work area for the focused station. It has four subtabs.

### Markets

Markets lists non-upgrade goods at the station when the station has stock or the ship is carrying that good.

Columns:

- **Good**: commodity name, with a fuel tag when it can fuel the ship.
- **Stock**: station stock.
- **Held**: amount of that good in the ship cargo.
- **Price**: buy price at this station.
- **Net Sell**: what the player receives per unit after the 15% port tax.
- **Action**: +10 and Buy/Buy max controls.

Buying rules:

- The ship must be docked and manual.
- Station stock must be available.
- The ship must have cargo space by mass.
- The ship wallet must cover the purchase.
- Purchases are paid into the station treasury.
- Suggested buys may use a route-aware quantity instead of full bay capacity, especially when the engine reserves space for contract goods.

### Upgrades

The station Upgrades subtab lists upgrade modules stocked at the current station. Buying a module puts it into cargo; it is not installed immediately from this panel.

The same docking, stock, funds, and cargo-space rules apply. The ship installs the module later from the ship card's Upgrades tab.

### Offers

Offers is the local crew board. It lists hire offers posted at the current station.

Offer details:

- role
- name
- tier
- hire cost
- wage per tick
- modifiers
- expiry

Hiring rules:

- The ship must be docked at the offer's station.
- Hire cost is paid from the ship wallet.
- Hiring consumes the offer.
- Hiring a role replaces any existing crew member in that role.
- Ship stats are recomputed after hiring.

### Contracts

Contracts shows station work and this ship's active work.

Contract types:

- **Shortage contracts**: a station needs a good that is below target stock.
- **Rescue contracts**: an NPC trader is stranded and needs fuel.
- **Trade settlement jobs**: exchange-related settlements assigned automatically, collected separately.

Contract rows show tier, requested good, destination, quantity, held amount, reward, penalty, and expiry.

Tier rules:

- Low tier has longer expiry and no penalty.
- Medium tier has shorter expiry and a partial penalty.
- High tier is urgent and can penalize the full reward amount.

Acceptance and delivery:

- Only player ships can accept contracts.
- Shortage contracts are normally visible at the destination station.
- Rescue calls are broadcast.
- Accepted delivery contracts are credited when the ship sells matching cargo at the destination.
- Jobs credit high-tier contracts first.
- Partial deliveries update progress but do not pay the reward until complete.
- Abandoning or letting an accepted contract expire charges its penalty to the ship wallet.

## Info Card

The info card changes based on what the player is inspecting.

### Ship Info

The default view shows:

- ship wallet
- cargo mass versus capacity
- fuel amount versus fuel capacity
- hull damage
- speed
- hull
- upgrade count
- crew count
- weapon power
- service debt
- crew wages per tick

In transit, it also shows progress toward arrival.

### Station Info

Clicking or hovering a station shows station context:

- station type/scale tags
- population
- tech level
- traffic counts
- local contracts
- stocked goods and upgrades
- export/import flow
- market pressure rows

This is useful for deciding whether a station is a producer, consumer, hub, or shortage target.

### Trade Helper

Clicking or hovering a good opens the trade helper. It explains that good at the focused station and for the selected ship.

It can show:

- station stock versus target stock
- buy price and net sell price
- max buy based on funds, stock, and cargo room
- held quantity and weighted average paid
- cargo lot history
- nearest demand
- best remote price
- route profit/loss after travel fuel, maintenance, and docking
- break-even quantity when a route is not profitable at current size
- station production and consumption flow
- related contracts

The helper is intentionally route-aware: a high sell price is not enough if fuel, maintenance, docking, or insufficient cargo quantity makes the route unprofitable.

## Suggestions

When the ship has a navigator, My Fleet highlights suggested actions. The guidance engine evaluates the current ship state and returns a best next step, such as:

- refuel
- buy for a route
- sell here
- travel to sell
- accept a contract
- collect an exchange settlement
- execute a multi-good route plan
- wait because the ship is blocked

In manual mode, suggestions are advice. The player still clicks the action. In auto mode, suggestions reflect what the auto-pilot is trying to do when the required crew exists.

## Auto-Pilot

Auto-pilot is gated by crew:

| Crew | Auto behavior |
|---|---|
| No captain | Auto mode idles. The ship will not trade by itself. |
| Captain | Refuels, picks profitable cargo routes, departs, sells on arrival, handles exchange settlement travel, scores shortage contracts, can accept matching destination shortages, can run multi-good loadout plans, and may reposition when no local trade is available. Maintenance debt can still accrue. |
| Captain + Mechanic | Captain behavior plus automatic maintenance payment. |
| Captain + Navigator | Captain behavior plus the My Fleet guidance UI, so the player can see highlighted recommendations and the auto-pilot's current intended action. Maintenance debt can still accrue without a mechanic. |
| Full crew | Automated trading, guidance highlights, and automatic maintenance payment. |

Auto-pilot uses the same underlying market and route math as NPC traders, with player-specific contract awareness layered on top.

## Important Numbers

| Rule | Current value |
|---|---:|
| Starting ship wallet | Ç55,000 |
| Starting cargo capacity | 60 |
| Starting fuel capacity | 60 |
| Starting speed | 1 |
| Starting hull | 3 |
| Port tax on sells | 15% |
| Docking fee | Ç5 per ship capacity |
| Maintenance in transit | Ç0.5 per ship capacity per tick |
| Idle maintenance | 0 |
| Cargo unload duration | 4 ticks before modifiers |
| Maintenance debt grounding threshold | Ç8,000 |

## Source Notes

This page is based on the current My Fleet UI and mechanics in:

- `src/ui/views/PlayerView.tsx`
- `src/ui/components/TopBar.tsx`
- `src/sim/data/player.ts`
- `src/sim/traders.ts`
- `src/sim/crew.ts`
- `src/sim/jobs.ts`
- `src/sim/upgrades.ts`
