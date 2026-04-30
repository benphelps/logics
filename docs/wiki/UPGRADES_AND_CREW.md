# Upgrades & Crew

Upgrades and crew both modify the selected ship. Upgrades are installed modules that occupy ship slots. Crew are hired people who occupy role slots. Both feed into the same ship modifier system, so their effects stack before the game computes capacity, fuel, speed, route cost, maintenance, exchange payouts, and related actions.

## Shared Modifier Rules

Installed upgrades and hired crew are additive. A ship can have one crew member in each crew role and one upgrade in each upgrade slot.

Some modifiers change ship stats immediately when the ship is recomputed. Other modifiers are read when an action happens.

| Modifier | Effect |
|---|---|
| `cargoCapacityBonus` | Adds flat cargo capacity. |
| `fuelCapacityBonus` | Adds flat fuel tank capacity. Current fuel is capped to the new tank size after recompute. |
| `speedBonus` | Adds flat speed, reducing normal travel time. |
| `hullBonus` | Adds hull rating. Current UI displays it; future danger/combat systems can read it. |
| `weaponPowerBonus` | Adds weapon rating. Current UI displays it; future danger/combat systems can read it. |
| `rangeEfficiency` | Reduces fuel per distance. Stacks additively, then fuel use is floored at 10% of the base rate. |
| `unloadSpeedBonus` | Speeds up cargo unloading. A value of `1.0` halves normal unload duration. |
| `instantUnload` | Cargo sales and auto-arrival unloads settle immediately. |
| `remoteSettlementCollection` | Eligible exchange settlements pay immediately instead of creating a station collection job. |
| `instantTravel` | Plotted travel resolves on departure. |
| `fuelFreeTravel` | Travel requires and burns no fuel. |
| `buyDiscount` | Reduces market buy prices, capped at 50%. |
| `sellPremium` | Increases market sell payout, capped at 50%. |
| `maintenanceDiscount` | Reduces maintenance cost before it is paid or added as debt. |
| `contractRewardBonus` | Increases contract reward credited on completion. |
| `dockingDiscount` | Reduces docking fee, capped at 90%. |
| `fuelRegenIdle` | Refills fuel while docked and idle. |
| `treasuryYield` | Pays idle ship-wallet yield from the dock's station treasury, capped at 1% per tick. |
| `dividendBonus` | Adds a bonus on long-position dividend payouts. |

## Upgrade Rules

Upgrade modules are goods until installed. They can be bought at stations, carried in cargo, sold like cargo, or installed into a ship slot.

Rules:

- The ship must be docked to install, remove, or replace upgrades.
- Buying a station upgrade puts one module into cargo.
- Installing from cargo consumes one module unit.
- Replacing a module moves the old installed module into cargo at the current station.
- Removing a module moves it into cargo.
- Install/remove/replacement is rejected if the resulting cargo mass would exceed ship capacity.
- Selling a carried module uses the normal cargo sell flow and unload timing unless the ship has instant unload.

Upgrade rarity follows the UI tier scale:

| Tier | Rarity |
|---:|---|
| 1 | Common |
| 2 | Uncommon |
| 3 | Rare |
| 4 | Legendary |

## Upgrade Slots

| Slot | Purpose |
|---|---|
| Cargo Hold | Cargo capacity and unload handling. |
| Engines | Speed, travel time, and fuel-per-distance efficiency. |
| Fuel Tanks | Fuel capacity, fuel efficiency, regeneration, and fuel-free travel. |
| Hull | Hull rating and maintenance survivability. |
| Weapons | Weapon rating and combat/contract-oriented bonuses. |
| Ship Systems | Exchange, contract, docking, yield, dividend, and trading support systems. |

## Cargo Hold Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Standard Cargo Bay | +15 cargo |
| 1 | Modular Container Bay | +8 cargo, +50% unload speed |
| 2 | Heavy Hauler Frame | +35 cargo |
| 2 | Rapid Cargo Lift | +10 cargo, +100% unload speed |
| 2 | Smuggler's Compartment | +22 cargo, -6% maintenance |
| 3 | Megahauler Conversion | +60 cargo |
| 3 | Zero-G Unload Matrix | +20 cargo, instant unload |
| 4 | Atlas Hauler Spine | +90 cargo |

## Engine Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Vector Thrusters | +0.25 speed |
| 1 | Solar Sail Rig | +0.15 speed, -10% fuel per distance |
| 2 | Slipstream Drive | +0.5 speed, -10% fuel per distance |
| 2 | Microjump Coil | +0.4 speed, -6% maintenance |
| 3 | Singularity Burst Drive | +1.4 speed |
| 4 | FTL Fold Drive | +1 speed, instant travel |

## Fuel Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Fuel Reclaimer Pump | +15 fuel, -8% fuel per distance |
| 1 | Solar Bloom Collector | +8 fuel, -12% fuel per distance |
| 2 | Hydrogen Spinner Reclaimer | +35 fuel, -18% fuel per distance |
| 2 | Auxiliary Tank Lattice | +60 fuel |
| 2 | Hyperion Bloom Reclaimer | +18 fuel, +0.5 fuel per tick while docked |
| 3 | Bio-Reactor Stack | +30 fuel, -30% fuel per distance |
| 4 | Zero-Point Fuel Core | +60 fuel, fuel-free travel |

## Hull Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Reinforced Plating | +1 hull |
| 2 | Composite Battle Plating | +2 hull, -5% maintenance |
| 2 | Ablative Plate Layers | +3 hull, -4% maintenance |
| 2 | Photon Damping Coat | +1 hull, +6% contract rewards |
| 3 | Adamant Carapace | +4 hull, -10% maintenance |
| 4 | Self-Repair Nanite Mesh | +3 hull, -20% maintenance |

## Weapon Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Pulse Cannon Turret | +1 weapon power |
| 1 | Point-Defense Lattice | +1 weapon power, -4% maintenance |
| 2 | Quad Gauss Battery | +3 weapon power, +5% contract rewards |
| 2 | Bounty Hunter Rig | +3 weapon power, +8% contract rewards |
| 3 | EMP Disruptor Array | +4 weapon power, -10% fuel per distance |
| 4 | Plasma Lance Array | +6 weapon power, +10% contract rewards |

## Ship Systems Modules

| Tier | Module | Effects |
|---:|---|---|
| 1 | Survey Computer | +3% contract rewards |
| 1 | Haggler's Earpiece | +5% contract rewards |
| 2 | Exchange Relay | Remote exchange settlement collection |
| 2 | Bridge Ticker Tape | +6% contract rewards |
| 2 | Bonded Treasury Module | +0.08% per tick treasury yield, +4% contract rewards |
| 2 | Diplomatic Beacon | -30% docking fee |
| 2 | Negotiator's Console | -4% buy price, +4% sell payout |
| 3 | Pressure Atlas Console | +10% contract rewards, -6% maintenance |
| 3 | Shareholder Relations Suite | +12% dividends, +0.05% per tick treasury yield |
| 4 | Oracle Trade Core | Remote exchange settlement collection, +12% contract rewards, +3% sell payout |

## Crew Roles

Crew roles are ship-local. Hiring replaces any existing crew member in that role.

| UI role | Sim role | Main unlock | Possible rolled modifiers | Base hire | Base wage | Offer weight |
|---|---|---|---|---:|---:|---:|
| Pilot | `captain` | Auto-pilot trading | speed, fuel efficiency, sell premium, buy discount | Ç140,000 | Ç9/t | 2 |
| Navigator | `navigator` | Guided hints and highlighted next actions | fuel capacity, fuel efficiency, contract rewards | Ç18,000 | Ç3/t | 5 |
| Mechanic | `mechanic` | Auto-paid maintenance and no maintenance debt | cargo capacity, maintenance discount, fuel capacity, unload speed | Ç40,000 | Ç3/t | 3 |

## Hiring And Firing

Hire offers are posted per station. The Offers tab only shows offers at the current station.

Rules:

- The ship must be docked at the offer's station.
- The ship wallet pays the hire cost.
- Hiring consumes the offer.
- Hiring a role replaces the existing crew member in that role.
- Firing is only available while docked.
- Firing stops future wages and gives no refund.
- Ship stats are recomputed after hiring or firing.

Offer generation:

- A station can have up to 6 open hire offers.
- Each station has a base 6% per-tick chance to post an offer, scaled by population and tech level.
- Higher-tech stations can roll higher-tier crew more often.
- Tier 1 offers expire after 100 ticks.
- Tier 2 offers expire after 140 ticks.
- Tier 3 offers expire after 200 ticks.

## Crew Tiers

Crew tiers change cost, wage, and modifier count.

| Tier | Hire multiplier | Wage multiplier | Modifier count |
|---:|---:|---:|---:|
| 1 | 1.0x | 1.0x | 0 |
| 2 | 1.5x | 1.6x | 1 |
| 3 | 2.4x | 2.4x | 2 |

Tier 1 crew are mainly role unlocks. Tier 2 and Tier 3 crew add small specialist modifiers.

## Crew Modifier Ranges

Generated crew use small modifier ranges.

| Modifier | Generated range |
|---|---:|
| Cargo capacity | +2 to +6 |
| Fuel capacity | +3 to +8 |
| Speed | +1, Tier 3 only |
| Fuel efficiency | 3% to 10% |
| Unload speed | 6% to 15% |
| Buy discount | 2% to 5% |
| Sell premium | 2% to 5% |
| Maintenance discount | 4% to 10% |
| Contract reward bonus | 3% to 10% |

Tier 2 rolls use the lower half of a modifier's range. Tier 3 rolls use the upper half.

## Maintenance And Wages

Crew wages are charged every tick from the ship wallet.

Maintenance behavior depends on whether the ship has a mechanic:

- With a mechanic, maintenance is paid automatically from the ship wallet, with maintenance discount applied.
- Without a mechanic, maintenance becomes visible maintenance debt instead.
- Wages are still paid even when maintenance becomes debt.
- When maintenance debt reaches `MAINTENANCE_DEBT_TRAVEL_BLOCK`, currently Ç8,000, the ship cannot depart until repaired.

Repairing pays the full maintenance debt from the ship wallet and clears the debt.

## Automation And Guidance

Crew unlocks different layers of player assistance:

| Crew state | Result |
|---|---|
| No Pilot | Auto mode idles. The ship will not trade by itself. |
| Pilot | Auto-pilot can refuel, trade, sell on arrival, service exchange settlement travel, score shortage contracts, accept matching destination shortages, run loadout plans, and reposition. |
| Navigator | My Fleet guidance and action highlights become visible. Navigator alone does not make Auto mode trade. |
| Mechanic | Maintenance is auto-paid and maintenance debt no longer accumulates. |

The strongest early path is usually Navigator for advice, Pilot for automation, and Mechanic before maintenance debt becomes a routing problem.

## Source Notes

This page is based on:

- `src/sim/upgrades.ts`
- `src/sim/hires.ts`
- `src/sim/crew.ts`
- `src/sim/traders.ts`
- `src/sim/economy.ts`
- `src/sim/jobs.ts`
- `src/sim/stock.ts`
- `src/ui/views/PlayerView.tsx`
