# Combat

Combat is the hostile-contact system that can interrupt ships during transit. It is not a separate tactical minigame. When an encounter reaches a manual player ship, the game pauses on a modal and asks for one decision: fight, flee, or negotiate.

Most cargo runs do not create a hostile contact. The system exists to make high-value routes, border crossings, low-reputation territory, mercenary crew, weapon modules, lane danger, and combat history matter.

## When Encounters Happen

Every ship in transit can roll for a hostile contact after the early-game warmup. The roll is small and bounded:

| Signal | Effect |
|---|---:|
| Base transit chance | 5% per transit tick |
| Different syndicates at origin and destination | +1.5% |
| Ship entering territory outside its home syndicate | +1.5% |
| Valuable cargo | small value-based increase |
| Final chance | clamped from 3% to 7% |
| Per-ship cooldown after a spawn | 8 ticks |
| New-game warmup | 100 ticks |

News events can also raise or lower encounter chance. The clamp still applies, so news can make a lane noticeably calmer or hotter without turning the sector into a constant ambush chain.

## Encounter Modal

Manual player ships pause on a pending encounter. The modal shows:

- the current tick and route
- your ship stats
- attacker stats
- mercenary tier, if one is aboard
- fight, flee, and bribe or negotiate choices
- fuzzy odds bands instead of exact percentages
- concrete loss pills for the risks attached to each choice

The modal cannot be dismissed. Pick an action to resolve the encounter and let the world continue ticking.

## Choices And Odds

Each choice rolls against a hidden probability and shows the player a readable odds band: very likely, likely, even, risky, or longshot.

| Choice | What improves it | Success | Failure |
|---|---|---|---|
| Fight | weapon power and mercenary tier | attacker is driven off | cargo, credits, and hull can be lost |
| Flee | ship speed | ship escapes cleanly | hull damage |
| Bribe or negotiate | cash on hand; reputation for rival syndicates | pirates take a smaller payment/cargo slice; rivals can stand down | bribe can be paid and the fight loss can still apply |

Pirates use a flat negotiation chance. Rival syndicates use reputation, so a faction that already trusts you is easier to talk down.

## Losses

Combat losses are concrete rather than abstract. The modal lists the actual cargo, credits, or hull damage that can happen before you choose.

Important rules:

- fight failure can take cargo, credits, and hull
- flee failure only damages hull
- negotiation always needs the bribe up front
- a failed negotiation pays the bribe and then applies the fight loss
- cargo loss prefers lighter goods first
- credit loss is capped so one bad roll does not erase a wealthy ship wallet

## Mercenaries And Weapons

The mercenary crew role is the strongest combat lever. Mercenary tier adds effective weapon power when calculating fight odds, and auto-pilot is more willing to fight when a mercenary is aboard.

Weapon upgrades and combat-capable hulls matter too. Shipyards can sell cruisers and exotic hulls with higher base weapon power or extra weapon mounts, and weapon modules improve the ship side of the fight calculation.

## Auto-Pilot Policy

Auto ships resolve encounters without opening the modal. The policy is simple:

| Condition | Auto choice |
|---|---|
| mercenary aboard and fight odds are good enough | fight |
| negotiation odds are good enough and the ship can afford the bribe | negotiate |
| otherwise | flee |

NPC encounters also auto-resolve. They still feed the same encounter history, which is why the Ledger can show all ships and the Atlas can show lane danger even when the player was not directly involved.

## Ledger And Atlas History

Resolved encounters are recorded in the Ledger Combat tab. Use the Mine scope for player ships or All ships for fleet-wide and NPC activity. Rows show tick, ship, choice, outcome, attacker, route, and losses.

Atlas shows combat spatially. Logistics mode tints lanes by recent encounter density and can show fresh encounter pings. Lane danger is recent history, not a permanent route label: a busy corridor can cool down once the recent window passes.

## Related Pages

- [`LEDGER.md`](LEDGER.md) for the Combat tab and fleet-history feed.
- [`ATLAS.md`](ATLAS.md) for lane danger, logistics map mode, and news events.
- [`UPGRADES_AND_CREW.md`](UPGRADES_AND_CREW.md) for mercenaries, weapon modules, and hull traits.
- [`MY_FLEET.md`](MY_FLEET.md) for ship stats, cargo, travel, and auto-pilot.

## Source Notes

This page is based on:

- `docs/COMBAT.md`
- `src/sim/combat/encounters.ts`
- `src/sim/combat/log.ts`
- `src/ui/components/EncounterModal.tsx`
- `src/ui/views/ChartersView.tsx`
- `src/ui/views/LocationsView.tsx`
- `src/sim/types.ts`
