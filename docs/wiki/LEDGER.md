# Ledger

Ledger is the career, faction, combat, and history screen. It does not run ships directly. It explains what the player has unlocked, how the player stands with syndicates, what encounters have happened, and what the fleet has been doing.

The main Ledger tab has four subtabs: Charters, Syndicates, Combat, and Log. The Captain's Ledger sidebar stays available beside them.

## Screen Layout

Ledger is split into:

- a wide tabbed panel for career records, syndicate standing, combat encounters, or fleet log entries
- a right sidebar for game kind, career progress, next unlock, player wallet context, and the universe backstory

Use Ledger when you need the answer to "what changed over time?" rather than "what should I click next?"

## Charters

Charters track manual player actions. Manual actions include player-driven ship operations and exchange orders. Auto-pilot actions do not advance the counter.

Charters unlock crew offer pools and upgrade tiers:

| Unlock | Actions | What changes |
|---|---:|---|
| Local Outfitters | 25 | Tier-1 modules can stock in station markets. |
| Navigator's Guild | 50 | Stations can post navigator offers; hired navigators unlock guidance. |
| Mechanic's Guild | 100 | Stations can post mechanic offers; hired mechanics handle maintenance. |
| Refit Yards | 150 | Tier-2 modules can stock in station markets. |
| Pilot's Guild | 250 | Stations can post pilot offers; hired pilots unlock auto-pilot trading. |
| Mercenary Hall | 350 | Stations can post mercenary offers; mercenaries improve combat odds. |
| Specialist Yards | 500 | Tier-3 modules can stock in station markets. |
| Apex Foundries | 900 | Tier-4 endgame modules can stock in station markets. |

Charter badges show earned and locked states. The next unearned badge tells you how many more manual actions are needed.

## Syndicates

Syndicates shows faction standing for the current seed. Each card can show:

- syndicate name
- trait label and description
- whether it is the player's aligned syndicate
- reputation band
- reputation percentage

Reputation matters for faction context and territory. The Atlas Syndicates and Logistics map modes visualize the same faction layer spatially.

## Combat

Combat records hostile contacts and their outcomes. The subtab can show:

- encounters involving the player's ships
- encounters from all ships when using the All ships scope
- tick
- ship
- player or auto choice
- outcome
- attacker
- route
- cargo, credit, or hull losses

Manual ships can pause on a pending encounter and ask the player to fight, flee, or negotiate. Auto ships choose a policy automatically. Mercenaries improve the case for fighting when the odds are favorable.

For the encounter rules, choice outcomes, loss model, and Atlas danger integration, see [`COMBAT.md`](COMBAT.md).

## Log

Log merges fleet action history and exchange trade records into one feed. Entries can include:

- cargo buys and sells
- refuels
- departures and arrivals
- contract accepts, completions, expiries, and abandons
- encounter events
- exchange opens, adds, closes, shorts, covers, stops, and take-profits

The feed is newest-first and can page older entries from local history storage.

## Captain's Ledger

The sidebar summarizes the save:

- game kind
- manual action count
- charters earned
- next unlock
- fleet ship count
- fleet wallet
- flagship
- current tick
- activity placeholders for longer-term totals
- universe backstory when present

The backstory eyebrow can expand into political, economic, tension, and timeline context generated for the save.

## Related Pages

- [`MY_FLEET.md`](MY_FLEET.md) for the manual actions that advance Charters.
- [`ATLAS.md`](ATLAS.md) for lane danger, encounter pings, and syndicate territory.
- [`COMBAT.md`](COMBAT.md) for fight, flee, negotiate, auto-pilot policy, and encounter losses.
- [`UPGRADES_AND_CREW.md`](UPGRADES_AND_CREW.md) for crew roles, wages, modifiers, and unlock tables.
- [`EXCHANGE.md`](EXCHANGE.md) for trade records shown in the Log feed.

## Source Notes

This page is based on:

- `src/ui/views/ChartersView.tsx`
- `src/ui/views/LocationsView.tsx`
- `src/ui/historyDb.ts`
- `src/sim/milestones.ts`
- `src/sim/control.ts`
- `src/sim/combat/encounters.ts`
- `src/sim/combat/log.ts`
- `src/sim/types.ts`
