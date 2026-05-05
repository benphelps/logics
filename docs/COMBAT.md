# Combat

Combat in Ledgway is something you negotiate, not something you grind.
The sector is busy with traffic, and pirate gangs and rival syndicate
patrols see that traffic the same way you see a glutted commodity market —
as an opportunity. When one of them notices your ship, you get a single
moment of agency: **fight, flee, or negotiate**. The dice resolve, you
take a hit (or you don't), the log writes a line, and you keep flying.

There's no turn-based combat layer, no health bar drained over many
rounds, no tactical grid. The whole encounter is a probability check
wrapped in flavor — closer to a "Wasteland 2 random encounter" than to
"FTL". This file explains how the system is wired and the design choices
behind it.

> **Status:** implementation reference and design notes. The source of
> truth is the code in `src/sim/combat/encounters.ts` (mechanics),
> `src/sim/traders.ts` (trigger hook), `src/sim/news/modifier.ts` (news
> tie-in), and `src/ui/components/EncounterModal.tsx` (player-facing
> presentation).

## Why combat at all

The trade game is the heart of the simulation, but the sector reads as
"empty" without a danger signal. Combat exists to:

1. Give cargo runs **felt risk**. A bay full of antimatter feels
   different from a bay full of grain because the encounter chance
   scales with cargo value. Border crossings feel different from
   intra-syndicate hops because they bump the chance too.
2. Give the **mercenary** crew slot a reason to exist (and the
   **weapon** upgrade slot meaning beyond a UI badge). Both are
   inert without combat — they don't help with trading, scanning, or
   logistics. Combat is the one thing they touch.
3. Animate the **atlas**. NPC ships also roll for encounters, and the
   resulting heatmap on the Stations / Logistics map turns lanes amber
   or red when traffic is being harassed. It's the same world you read
   for trade routes, just with a second visual layer.
4. Hook the **news system**. Sector tension and deescalation can move
   the encounter rate up or down by editing one multiplier. A piece of
   news isn't just flavor text — it changes the danger map.

What we explicitly didn't want: real-time combat, ship-vs-ship hull
exchange, or anything that turns the trade loop into a gunner's loop.

## When an encounter fires

Every tick, every ship that's currently in `state: "transit"` gets a
chance to roll for a hostile contact. The roll is deliberately bounded
so it never feels like an ambush spree.

- **Base chance** is **5%** per transit-tick.
- A **border-crossing** lane (different syndicate at origin and
  destination) adds **+1.5%**.
- Crossing into **hostile** territory (the destination's syndicate isn't
  the ship's home) adds another **+1.5%**.
- High-value cargo nudges the chance up by `4 × 10⁻⁷` per credit of
  cargo value.
- The result is **clamped to [3%, 7%]**. The clamp is the most
  important number in the file — it stops cargo and news from spiking
  encounter rate to the point where two encounters fire on the same
  three-tick lane.

After a successful spawn, the ship has an **8-tick per-ship cooldown**
during which it can't roll again. And the world honors a
**100-tick warmup** at the start of a new game so the player never gets
intercepted in the first thirty seconds.

The data flow is simple:

```
stepTrader (per tick, per ship)
  └─ if state = transit and not in cooldown
       └─ encounterChance(world, ship)            ← computes the % above
       └─ rng() < p ? generateAttacker : skip
       └─ stamps world.pendingEncounter (player + manual or DEV)
          OR autoresolves via autopilotPolicy (everyone else)
```

## Who shows up

Two attacker kinds, picked at spawn time:

- **Pirate.** The default. Unaffiliated, reputation-immune, a bit
  weaker on average. Negotiation with a pirate is a flat 45% — they
  take a bribe and a slice of cargo, or they don't.
- **Rival syndicate.** A patrol from the destination's home syndicate.
  Only fires for the **player** ship, only when the player has joined
  a syndicate, only on cross-faction trips, and only when the player's
  reputation with the destination syndicate is below 0.4. Inside that
  window, 35% of encounters become rivals instead of pirates.

NPC ships always face pirates. We didn't want to model NPC reputation
networks on top of everything else; their cross-syndicate friction
shows up implicitly through the existing `tickControl` system.

The attacker's stats are scaled against the defender's: weapon power
and hull are rolled relative to the defender's own weapon and hull,
and speed is rolled relative to the defender's speed. So a stock
freighter with weapon 0 will face a weak attacker (because the random
range is "0× to 1.3× of your weapon, plus a small flat constant"), and
a heavily-armed cruiser will face a beefier one.

## The three choices

A pending encounter offers `fight`, `flee`, or `negotiate`. Each
has its own success probability:

- **pFight = 0.50 + 0.40·tanh(weaponDelta / 8)**, where
  `weaponDelta = ship.weaponPower + 4·mercTier − attacker.weaponPower`.
  A tier-3 mercenary is worth +12 weapon — usually enough to flip a
  fight from "longshot" to "likely". Win the roll → `won`. Lose the
  roll → `lost` and the fight loss applies (cargo + a capped credit
  hit + hull damage).
- **pFlee = 0.55 + 0.40·tanh(speedDelta / 4)**. Speed is much sharper
  than weapon — even +2 speed gives ~85% escape. Win → `escaped`,
  clean. Lose → `fled_damaged`, and you take a hull chip.
- **pNegotiate = 0.45** vs pirates (flat) or **0.30 + 0.40·rep** vs
  rivals (so high reputation makes peace very buyable). Negotiation
  always costs the bribe up front. Success against a pirate is
  `negotiated_partial` (you keep the bribe, they take a small cargo
  slice). Success against a rival is `negotiated_peace` (clean walk).
  Failure is `negotiated_fail` — you paid the bribe **and** still take
  the full fight loss.

The probabilities are also presented to the player as fuzzy odds bands
(`very_likely`, `likely`, `even`, `risky`, `longshot`) so the modal
reads as a tactical gut call rather than a calculator. The exact
percentage is never surfaced.

## Fighting solo vs hiring help

This is the cleanest gameplay lever we have. The mercenary crew slot
is dedicated to combat, and a tier-3 merc adds +12 to your effective
weapon power. With a stock freighter (weapon 0) and a tier-3 merc:

- vs an attacker rolling weapon 1-7, you have ~70-90% pFight.
- The autopilot policy flips: with a merc on board, it picks **fight**
  if pFight ≥ 0.55. Without one, it falls through to negotiate
  (if the bribe is affordable and pNegotiate is reasonable) or flee.

The **autopilot policy** matters because every NPC encounter and every
player-on-auto encounter that doesn't pause uses it. A summary:

```
hasMerc and pFight ≥ 0.55      → fight
pNegotiate ≥ 0.50 and afford   → negotiate
otherwise                       → flee
```

In dev mode (`?dev=1`), an auto-piloted player ship without a merc
**still surfaces the modal** so you can choose manually. This is the
case we expect from a player who's been investing in cargo capacity
but hasn't hired a mercenary yet — the dev affordance lets us inspect
that path without forcing manual pilot mode.

## Losses

When a choice fails, here's what comes off the ship:

- **Fight loss** — 30% of cargo mass (lightest goods first, coalesced
  across lots so the modal reads cleanly), plus a credit hit capped at
  `min(funds × 5%, Ç25,000)`, plus 25% of base hull.
- **Flee loss** — 10% of base hull. No cargo, no credits.
- **Negotiation cost** — a bribe of `Ç1,500 + 4% of cargo value`,
  capped at `Ç50,000`, plus a small cargo concession on a successful
  pirate negotiation.
- **Failed negotiation** — bribe paid + full fight loss applied.

The "lightest goods first" rule is intentional. We don't want a player
to lose their high-tier electronics because pirates rolled the dice in
their favor; pirates take what's easy to lift, and that's the lighter
cargo. It also gives the cargo-loss messaging a cleaner story
("They took the grain, left the antimatter").

The credit cap matters because we don't want a wealthy ship to be
bankrupted by a single bad fight. Credit losses are framed as
"boarding spoils" rather than "they took your wallet" — small,
flat, capped.

## Reputation feedback

Every encounter against a rival syndicate moves the player's
reputation with that syndicate:

- `negotiated_peace` → +0.04 (small bump toward 1.0)
- `won`, `lost`, `negotiated_fail` → −0.06

Pirates have no syndicate, so reputation is untouched. The bumps are
small because the encounter rate is small — over a long campaign, a
syndicate you keep paying off will trend toward "negotiable", and a
syndicate you keep blasting will trend toward "permanently hostile".

This feeds back into **pNegotiate** for next time, so reputation isn't
just a number on a screen — it's a pricing input.

## News × encounters

The news system can tag an event with the `encounter_chance` scope.
When that event is active, `eventMultiplier(world, "encounter_chance",
ctx)` returns a multiplier between 0.25× and 4× that's folded into the
spawn-rate calculation. The clamp at 3-7% means most of the upside is
absorbed (a "+60%" event yields about +12% real encounter lift), but
the downside has plenty of room to fall (a "-60%" event yields about
−47% real reduction). That asymmetry is intentional: news can make
things calmer dramatically, but can't override the design's worst-case
ceiling on its own.

Two example LLM headlines that would land in this scope:

- **"Marshal Quorum Patrols Step Up Sector-Wide"** — direction +1,
  magnitude 0.4, target syndicate Marshal Quorum. Routes through their
  territory get more encounters for the duration; routes elsewhere
  don't.
- **"Black Aubade Lieutenants Captured After Trading Hub Sting"** —
  direction −1, magnitude 0.5, target global. Encounter rates drop
  across the board for the event's lifetime.

The news system handles the magnitude / direction / target target/scope
plumbing in `src/sim/news/modifier.ts`. Combat just reads the
multiplier when it computes the spawn chance and moves on.

## Atlas integration

Every resolved encounter is appended to `world.encounterHistory` (capped
at 500 entries in memory) **and** to a per-game IndexedDB store
(`STORE_ENCOUNTERS`, unbounded). The atlas reads the in-memory list to
draw two things:

- **Lane danger tint** — for each lane, count encounters in the last
  250 ticks. Less than 5 = "calm" (muted green), 10 = "medium" (amber),
  20+ = "hot" (red). The colors interpolate smoothly along an OKLCH
  ramp so a quiet sector still reads green, not grey. Calm by default
  is the most important state — the sector should not look angry.
- **Live pings** — small rings on the logistics tab that fade out
  over a few ticks, marking where the most recent encounters fired.
  They're slightly larger on the logistics tab than the stations tab
  so the ledger and the ping animation read as one screen.

The IDB store backs the Captain's Ledger combat tab, which paginates
older entries via IntersectionObserver. The 500-cap on
`world.encounterHistory` matches the design intent — the heatmap window
is 250 ticks, two encounters per tick on a busy sector fits comfortably.
We bumped it from the player-only era's 200 once NPC encounters started
recording into the same list.

## Persistence and the modal

For a player ship in **manual** mode, an encounter sets
`world.pendingEncounter` and the modal pauses every ship's transit
advance until the player picks. There's only ever one pending
encounter at a time — the modal is non-dismissable, and the choice has
to be made before the world ticks again.

The modal is opinionated about layout: two stat columns (player ship
on the left, attacker mirrored and red-tinted on the right), three
action cards stacked under them. Each action card lists the odds band
plus the loss pills (`-30 grain`, `-Ç1,250`, `-3 hull`) packed
tightly with longest-first interleave so a "Fight" card with five
loss types still fits two lines instead of five. The ship art fills
the stat columns full-bleed; we deliberately picked stronger artwork
over heavy informational chrome because the encounter is the most
"cinematic" beat in the game.

Player ships in **auto** mode without a mercenary auto-resolve the
encounter via `autopilotPolicy`. The exception is dev mode (`?dev=1`),
which forces the modal to pause even on auto so we can inspect the
flow without swapping pilots.

NPC ships always auto-resolve. Their resolution flows into ship logs
and the encounter history exactly the same as the player's, so the
ledger feed shows both "you" and "them" in one stream.

## What this all means at the table

A few high-level reads from the design:

- **Every cargo run carries a small, bounded danger tax.** Most runs
  fire zero encounters; long runs fire one or two. A cargo-heavy player
  on a hostile border crosses into the worst-case 7% per-tick rate, but
  only there.
- **The mercenary is the strongest single combat upgrade.** A tier-3
  merc converts most fights into wins. Without one, a no-weapon ship
  should always flee and a low-rep diplomatic ship should sometimes
  negotiate.
- **Speed is more useful than weapons** for survivability. A scout
  with a +2 speed edge escapes 85% of pirate encounters with no hull
  cost — better than a fight win rate at parity weapons, and free.
- **Pirates are fight-or-flee. Rivals are negotiate-or-flee.** That
  asymmetry comes from the rep input on rival negotiate odds: you can
  buy peace with a syndicate you have a relationship with, but pirates
  always want at least a slice of your cargo.
- **NPC encounters don't materially affect the simulated economy.**
  The autopilot policy + the round-down on flee hull damage means
  NPC encounters resolve as zero-impact "atmosphere" almost every
  time. That's a knob we can turn, but we left it where it is to keep
  the sector feeling alive without starving NPC traders out of
  business. See `docs/COMBAT_REPORT.md` (or the HTML version) for
  the full director-facing review and the data behind this
  observation.

## Tests

- `src/sim/combat/encounters.test.ts` — odds shape, resolution
  paths, cooldown, reputation deltas, the "lightest first" cargo
  selector, and the Monte-Carlo-style sanity checks on each outcome.
- `src/sim/combat/economy.test.ts` — credit cap, hull repair cost,
  bribe ceiling, fight-loss interaction with funds.
- `src/sim/scenarios/combat_report.ts` — non-test telemetry
  harness that runs scenarios end-to-end and writes JSON traces to
  `.logics-cache/combat_report/` (gitignored). Useful for validating
  tuning changes without re-reading hours of trace.
  Reproduce with `HORIZON=4000 npx tsx src/sim/scenarios/combat_report.ts`.

## Things we left as future work

- **NPC negotiation paths.** Today NPCs always flee. Lowering
  `AUTO_NEGOTIATE_MIN_P` from 0.50 to 0.40 would let high-cargo NPCs
  occasionally bribe their way out, which would put a small economic
  drag on the NPC fleet in exchange for richer log feeds.
- **Floor flee hull damage at 1.** Right now `floor(baseHull × 0.10)`
  rounds NPC fled-damaged outcomes to 0 because NPC base hulls are
  small. If we want NPC ships to actually wear down, this is the
  one-line fix.
- **Weapon-aware autopilot policy.** Currently the policy keys on
  mercenary presence; an "armed" ship without a merc still flees.
  Switching the policy to consider raw weapon power (or letting weapon
  power partly substitute for mercenary tier) would make hardpoint
  upgrades meaningful even before hiring crew.
- **Multi-weapon mounts beyond cruiser/exotic.** The data layer
  already supports `weapon`, `weapon_2`, and `weapon_3` slots, but only
  cruiser (2) and exotic (3) ship classes expose them. Future ship
  classes can pick up the additional mounts without code changes.
