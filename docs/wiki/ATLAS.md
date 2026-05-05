# Atlas

Atlas is the map and station intelligence screen. Use it to understand where stations are, which lanes connect them, where ships are moving, which syndicates control territory, where danger has been happening, and what a selected station offers.

Atlas does not replace Cargo. It tells you where the opportunities and risks are so you can decide which ship should act.

## Screen Layout

Atlas has three working areas:

- The upper-left map panel shows stations, lanes, ships, territories, and danger depending on the active map mode.
- The lower-left sheet switches between Systems, Ships, and Events.
- The right detail panel explains the selected station and can show exchange context, production flow, local markets, crew, upgrades, contracts, and shipyard inventory.

Click a station on the map or in the Systems table to update the detail panel. Click a ship in the Ships table or on the map to select it in the global ship picker.

## Map Modes

Atlas has three map modes:

| Mode | What it emphasizes |
|---|---|
| Stations | Station kinds, lane distances, selected station, route preview, and ship positions. |
| Syndicates | Faction territory and control boundaries. |
| Logistics | Lane traffic, recent encounter danger, reputation coloring, and fresh encounter pings. |

The map supports pan and zoom. Hovering lanes, stations, or ships shows local tooltips.

## Systems Table

Systems is the station sheet. It is sortable and shows each station's:

- station name and faction
- station equity move
- treasury ratio
- local crew postings
- local upgrade stock
- docked or inbound ships
- active jobs
- market pressure

Use this table when you know the kind of signal you want and need to find the station quickly.

## Ships Table

Ships lists traffic across the sector. Player and NPC ships can both appear. The table helps you find where ships are docked, what is in transit, and which corridors are busy.

For the player's fleet, use the ship picker or Cargo for direct controls. Atlas is better for broad visibility.

## Station Detail

The station detail panel can show:

- station tags, faction, and syndicate control share
- tech level, population, routes, docked ships, inbound ships, and contracts
- station equity quote, treasury ratio, net trade flow, dividends, basis spreads, and futures delivery context
- production and consumption flow
- shipyard inventory when the selected station is a shipyard
- crew offers
- upgrade stock
- market pressure rows
- local contracts and station news

The Travel action previews a route for the selected player ship. If no route is available, the panel explains the blocker.

## Shipyards

Shipyards are station types that sell ship blueprints. A shipyard listing can include:

- ship class such as Freighter, Courier, Hauler, Cruiser, or Exotic
- price
- cargo, speed, fuel, hull, weapons, and fuel type
- pre-installed upgrades
- built-in hull traits
- expiry timing

Buying a ship requires one of your ships to be docked at that shipyard with enough wallet funds. The purchased ship joins the player fleet at the same shipyard with its own empty wallet and a partial fuel tank.

Common hull traits:

| Trait | Effect |
|---|---|
| Self-piloted | Acts as if the ship has a pilot for automation gating. |
| AI navigator | Acts as if the ship has navigator guidance. |
| Extra slot | Grants a bonus upgrade socket where supported. |
| Fuel-efficient | Improves baseline fuel efficiency. |
| Rapid unload | Improves baseline unload handling. |

## Lane Danger And Events

The Logistics map mode tints lanes by recent encounter density. Fresh encounters can also appear as pings on the map.

Lane danger is a recent-history signal, not a permanent route label. A quiet lane can become risky after traffic and encounters shift, and a dangerous lane can cool down after the recent window passes.

See [`COMBAT.md`](COMBAT.md) for how encounters fire, resolve, and enter this recent-danger history.

The Events sheet lists active news events. Events can affect prices, maintenance, wages, docking, contract rewards, treasury behavior, dividends, share prices, futures, basis, or encounter chance depending on their effect scope.

## Related Pages

- [`MY_FLEET.md`](MY_FLEET.md) for direct ship controls.
- [`MARKETS.md`](MARKETS.md) for commodity-wide supply and demand.
- [`LEDGER.md`](LEDGER.md) for combat and fleet-history logs.
- [`COMBAT.md`](COMBAT.md) for hostile contacts, choices, losses, and lane danger.
- [`UPGRADES_AND_CREW.md`](UPGRADES_AND_CREW.md) for ship classes, crew, and modifiers.

## Source Notes

This page is based on:

- `src/ui/views/LocationsView.tsx`
- `src/ui/views/AtlasNewsPanel.tsx`
- `src/sim/geometry.ts`
- `src/sim/control.ts`
- `src/sim/shipyards.ts`
- `src/sim/combat/encounters.ts`
- `src/sim/news/*`
- `src/sim/types.ts`
