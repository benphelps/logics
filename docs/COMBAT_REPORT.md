# Combat System — Director's Review

**Author:** Combat report harness · **Horizon:** 4,000 ticks × 9 scenarios · **Strategy MC:** 2,000 trials × 5 profiles
**Source:** `src/sim/combat/encounters.ts`, `src/sim/news/spawn.ts`, telemetry from `src/sim/scenarios/combat_report.ts`

---

## TL;DR

The encounter pipeline is wired correctly and stable. Cadence holds at ~200 spawns / 100 ticks across seeds; news modulation moves the dial both ways; player-side rival vs pirate split lands on the design target. The model has clear levers (mercenary, weapon power, cargo value) and clean odds shape (`tanh`-blended).

But three things are quieter than the design implies:

1. **NPC encounters are atmospheric, not economic.** 100% of NPC encounters resolve as `flee`. Hull damage rounds to 0 for stock NPC hulls (2-3 base × 0.10 → 0). Across 24,064 NPC encounters in three baselines: **0 credits drained, 0 cargo lost, 0 recorded hull damage.**
2. **The 7% encounter clamp eats the cargo-value bonus past Ç75k.** Hauling a Ç200k or Ç500k bay produces the same spawn rate as a Ç75k bay.
3. **News modulation is asymmetric.** A "+60%" news event yields only **+12.5%** real encounter lift (clamp saturates upward fast); "-60%" yields **-47%** real reduction (room to fall is much larger).

Detail and data below.

---

## 1. System map — how the parts fit

```
                                   ┌───────────────────┐
                                   │     news system   │
                                   │  (LLM-generated)  │
                                   │  scope:           │
                                   │  encounter_chance │
                                   └─────────┬─────────┘
                                             │ multiplier (×0.25–×4.0, clamped)
                                             ▼
   ┌──────────┐   transit?   ┌─────────────────────┐  spawn?  ┌─────────┐
   │ stepTrader├─────yes────►│   maybeSpawnEncounter├──5±2%──►│ Encounter│
   │  (every  │   cooldown   │   • base 5%          │          │ object  │
   │   ship)  │   ≥ 8 ticks  │   • +1.5 border      │          └────┬────┘
   └──────────┘   warmup>100 │   • +1.5 hostile     │               │
                             │   • +cargo·4e-7      │               │
                             │   × news multiplier  │               │
                             │   clamp [3%, 7%]     │               │
                             └─────────────────────┘               │
                                                                    ▼
                          ┌────────────────────────────────────────┐
                          │            generateAttacker            │
                          │  isPlayer & ownSyn≠destSyn & rep<.4    │
                          │  ─ 35% rival_syndicate (player only)   │
                          │  ─ otherwise pirate                    │
                          │  scaled vs ship's weapon/hull/speed    │
                          └────────────┬───────────────────────────┘
                                       │
                          ┌────────────▼────────────┐    player + (manual or
                          │  pendingEncounter set?  │◄── DEV_MODE+no merc)?
                          └────────────┬────────────┘
                                       │
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
              ┌───────────────┐                ┌────────────────┐
              │  Modal pause  │                │ autopilotPolicy│
              │  (player UI)  │                │  fight if merc │
              │ fight/flee/   │                │  & pF≥0.55     │
              │ negotiate     │                │  else negotiate│
              └──────┬────────┘                │  if pN≥0.50    │
                     │                          │  else flee     │
                     ▼                          └────────┬───────┘
              ┌────────────────────────────────────────┐ │
              │          resolveEncounter             │◄┘
              │  RNG seeded by tick⊕ship⊕encounterId  │
              │  applies loss to ship.cargo / funds   │
              │  / hull, stamps reputation delta      │
              └────────────────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌──────────────┐    ┌────────────────┐    ┌──────────────┐
      │ encounter-   │    │ ship.log entry │    │ Atlas pings  │
      │ History      │    │ (toast / ledger│    │ + lane heat  │
      │ cap=500 mem  │    │  log feed)     │    │ window=250 t │
      │ unbounded IDB│    └────────────────┘    └──────────────┘
      └──────────────┘
```

Three integrations stand out:
- **News × encounters** via `eventMultiplier(world, "encounter_chance", ctx)`.
- **Atlas × encounters** via `world.encounterHistory` → lane danger intensity (count over a 250-tick window) → OKLCH green→amber→red lane tint.
- **Crew × combat** via `crew.mercenary.tier` → `+4 weaponPower` per tier in `pFight`, plus the autopilot threshold flip ("fight if merc, otherwise flee/negotiate").

---

## 2. Spawn cadence

### 2a. Per-tick cadence is stable post-warmup

Encounter count per 100-tick bucket, baseline (50-loc world, 100 NPCs, no player, seed 1001):

```
encounters/100t
        ╷
   250 ─┤ ▆
   200 ─┤ ▆  ▆ ▆ ▅ ▆ ▆ ▆ ▆ ▆ ▆ ▅ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆ ▆
   150 ─┤ █  █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █
   100 ─┤ █  █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █
    50 ─┤ █  █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █
     0 ─┴─0──1─2─3─4─5─6─7─8─9 10 ……………………………… (each cell = 100 ticks)
       ▲ warmup
```

Bucket 0 = 0 (the 100-tick warmup gates every spawn). Buckets 1-39 sit between **180 and 243** with mean **200.2**. Cross-seed variance is small: 8,007 / 7,821 / 8,236 over 4,000 ticks (±2.5% from the mean).

### 2b. Encounter-chance grid

Computed directly from `encounterChance(world, ship)`:

```
                                       cargo value (Ç)
spawn      0       5k      25k     75k     200k    500k
chance ┌────────────────────────────────────────────────
intra  │ 5.00%   5.20%   6.00%   7.00%   7.00%   7.00%
border+│ 7.00%   7.00%   7.00%   7.00%   7.00%   7.00%
hostile│  ▲ clamp hits at base+border+hostile = 8% → 7%
       └────────────────────────────────────────────────
```

The cargo-value bonus is `4e-7 × value`, so Ç75k pushes intra-syndicate routes straight to the **7% clamp**. Anything past that is invisible. Border-crossing routes are always pinned at the clamp regardless of cargo.

**Implication:** the cargo-value lever doesn't matter once a player is hauling above ~Ç75k unless they're on intra-syndicate routes. We could either lower the cap or scale the bonus — but the current design intentionally limits per-tick worst-case spawn to 7%, so any change has to weigh that.

### 2c. News modulation

Same world, with a synthetic global `encounter_chance` event injected at tick 91:

```
news multiplier  -60%      none      +60%
encounters       4,208    8,007    9,008
delta vs base    -47.4%    —      +12.5%
clamp behavior   floor=3%  base   ceil=7%
                 hits      —      hits
```

Both directions work; the asymmetry is the clamp. `eventMultiplier` itself can run from ×0.25 to ×4.0, but the encounter clamp is tight (3%-7%), so most of the news effect on spawn rate is consumed by the clamp on the upside. **Recommend** acknowledging this as "news can suppress spawns a lot, can boost them a little" — the +sign reads "sector tension" in the UI but resolves as an extra few rolls per 100 ticks rather than an avalanche.

---

## 3. Attacker generation

### 3a. Pirate vs rival split — design vs telemetry

The rival-syndicate gate fires only when:

```
isPlayerShip && ship.syndicateId && destSyn && destSyn ≠ ship.syndicateId
              && reputation[destSyn] < 0.4
              && rng() < 0.35       ← 35% rival roll inside the gate
```

NPCs always face pirates (the gate fails on `isPlayerShip`).

```
                pirate    rival   rival%   NPC encounters  rival on NPC?
baseline 1001   8,007       0     0.0%        8,007        no  ✓
baseline 2002   7,821       0     0.0%        7,821        no  ✓
baseline 3003   8,236       0     0.0%        8,236        no  ✓
player default  7,960       4    30.8% (4/13)   7,951      no  ✓ (4/4 player)
player + merc   7,961       5    38.5% (5/13)   7,953      no  ✓ (5/5 player)
player armed    7,960       4    30.8% (4/13)   7,951      no  ✓
player+a+merc   8,049       4    28.6% (4/14)   8,039      no  ✓
```

Player-side rival rate clusters at **28-38%**, matching the design's 35% gate roll within Monte-Carlo noise (n=13-14). NPC rivals stay at 0 across 24,064 baseline encounters — gating is correct.

### 3b. Attacker scaling

```
                weapon scale       hull scale        speed scale
pirate          [0.55, 1.30] +d6   [0.60, 1.20] +d8  [0.80, 1.20]
rival           [0.85, 1.45] +d6   [0.90, 1.40] +d8  [0.80, 1.20]
                 ▲ rivals lean stronger but variance overlaps pirates
crew level      [0.20, 0.70]      [0.45, 0.85]
                 (pirate)         (rival)
```

Stock NPC `baseWeaponPower=0` and `baseHull=2-3`, so attackers' weapon/hull are dominated by the additive `rangeFloat(rng, 0, 6)` / `rangeFloat(rng, 0, 8)` constants. Attackers land at roughly weapon 1-7, hull 1-9 against an NPC. That ratio ensures NPC pFight ≈ `clamp01(0.5 + 0.4·tanh((-3)/8)) ≈ 35%` — i.e. autopilot-flee is the only sane choice for a stock ship.

---

## 4. Odds and choice math

### 4a. The three odds curves

Visualizing how each curve responds to its input. All three pass through 0.5 at parity and clamp via `tanh` smoothing.

```
pFight = 0.50 + 0.40 · tanh((shipWeapon + 4·mercTier - attackerWeapon) / 8)

   p
  1.0 ┤                      ╭───────
  0.9 ┤               ╭──────╯
  0.8 ┤          ╭────╯
  0.7 ┤      ╭───╯
  0.6 ┤   ╭──╯
  0.5 ┤───╯ ← parity
  0.4 ┤ ╭──╯
  0.3 ┤╭──╯
  0.2 ┤── (asymptote 0.10)
  0.1 ┤
  0.0 ┴──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬─── weaponDelta
        -16 -12 -8 -4  0  4  8  12 16
```

`pFlee` uses the same shape on `(shipSpeed - attackerSpeed) / 4` — speed advantage of +2 already gives pFlee≈0.85. `pNegotiate` is fixed 0.45 against pirates and `0.30 + 0.40·rep` against rivals (so high rep means peace is very buyable, low rep means it's a coin flip below 50%).

### 4b. Strategy outcomes (Monte Carlo, 2,000 trials/strategy)

Stacked outcome bars per profile:

```
default ship vs balanced pirate (pF=0.30, pE=0.55, pN=0.45)
  fight:  won 30%▓▓▓▓▓▓ lost 70%░░░░░░░░░░░░░░░ │ avg loss Ç877  hull 0.7
  flee:   esc 56%▓▓▓▓▓▓▓▓▓▓▓ damaged 44%░░░░░░░░ │ avg hull 0.0 (rounds away)
  neg:    partial 44%▓▓▓▓▓▓▓ failed 56%░░░░░░░░░░│ avg loss Ç3702 hull 0.6

merc-armed cruiser vs pirate (pF=0.70, pE=0.55, pN=0.45)
  fight:  won 70%▓▓▓▓▓▓▓▓▓▓▓▓▓▓ lost 30%░░░░░░░░ │ avg loss Ç1505 hull 2.4
  flee:   esc 57%▓▓▓▓▓▓▓▓▓▓▓ damaged 43%░░░░░░░░ │ avg hull 1.3
  neg:    partial 47%▓▓▓▓▓▓▓ failed 53%░░░░░░░░░░│ avg loss Ç7635 hull 4.2

default ship vs rival w/ low rep (pF=0.30, pE=0.55, pN=0.30)
  fight:  won 29%▓▓▓▓▓▓ lost 71%░░░░░░░░░░░░░░░░ │ avg loss Ç886  hull 0.7
  flee:   esc 56%▓▓▓▓▓▓▓▓▓▓▓ damaged 44%░░░░░░░░ │ avg hull 0.0
  neg:    peace 30%▓▓▓▓▓▓ failed 70%░░░░░░░░░░░░ │ avg loss Ç5869 hull 0.7

default ship vs rival w/ high rep (pF=0.30, pE=0.55, pN=0.50)
  fight:  won 31%▓▓▓▓▓▓ lost 69%░░░░░░░░░░░░░░░░ │ avg loss Ç856  hull 0.7
  flee:   esc 53%▓▓▓▓▓▓▓▓▓▓ damaged 47%░░░░░░░░░ │ avg hull 0.0
  neg:    peace 50%▓▓▓▓▓▓▓▓▓▓ failed 50%░░░░░░░░ │ avg loss Ç5622 hull 0.5

fast scout vs slow pirate (pF=0.30, pE=0.85, pN=0.45)
  fight:  won 31%▓▓▓▓▓▓ lost 69%░░░░░░░░░░░░░░░░ │ avg loss Ç868  hull 0.7
  flee:   esc 85%▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ damaged 15%░░ │ avg hull 0.0
  neg:    partial 46%▓▓▓▓▓▓▓ failed 54%░░░░░░░░░░│ avg loss Ç3679 hull 0.5
```

Reads:
- Outcome rates track the configured `pX` to within ±2% across all profiles → RNG seeding is sound.
- **Negotiate is dominated** for default ships against pirates — Ç3,702 average versus Ç877 fight loss. Negotiate only wins when rep is high against rivals, where it's a clean 50/50 peace at high rep vs ~30% peace at low rep (hostile is more expensive than fighting).
- **Speed advantage matters more than weapon advantage** for survivability — the fast-scout profile escapes 85% of the time, no hull cost on success.
- **Merc-armed cruiser fight wins** are cheaper than negotiate failures — at pF=0.70, average fight loss (over all 2,000 trials including wins) is Ç1,505 vs Ç7,635 for a failed negotiate.

**Director takeaway:** the autopilot policy ("fight if merc + pF≥0.55, else negotiate if pN≥0.50, else flee") is correct given these numbers. A no-merc default ship should always flee unless it has a high-rep diplomatic out, which the policy handles.

---

## 5. Loss model

### 5a. Loss caps and shapes

```
fight loss      cargo: 30% mass, lightest goods first (coalesced across lots)
                credits: min(funds × 5%, Ç25,000)         ← capped flat
                hull: 25% of baseHull

flee loss       hull only: 10% of baseHull               ← rounds DOWN

negotiate       bribe: Ç1,500 + 4% of cargo value, max Ç50,000
                ┌─ pirate kind: success → partial cargo at 12% mass
                ├─ rival kind: success → walk clean (peace)
                └─ failure: bribe paid + full fight loss
```

A `Math.floor` rounding applies to flee hull damage. For a stock NPC trader (`baseHull=2-3`), `floor(2.5 × 0.10) = 0`. **Result: NPC `fled_damaged` outcomes have 0 hull damage.** This is the dominant reason NPC encounters drain nothing across 24,064 baseline samples.

### 5b. Loss-vs-strategy expected value

From the strategy MC (averages across 2,000 trials, including the unsuccessful side):

```
                                          fight      flee      negotiate
                                        cred·hull  cred·hull  cred·hull
default ship vs pirate                  Ç877·0.7    Ç0·0      Ç3702·0.6
merc-armed cruiser vs pirate            Ç1505·2.4   Ç0·1.3    Ç7635·4.2
default ship vs rival low-rep           Ç886·0.7    Ç0·0      Ç5869·0.7
default ship vs rival high-rep          Ç856·0.7    Ç0·0      Ç5622·0.5
fast scout vs slow pirate               Ç868·0.7    Ç0·0      Ç3679·0.5
```

Numbers are intentional: flee with a speed edge ≈ free. Fight with weapon edge ≈ a few thousand. Negotiate is the most expensive **except** when high rep makes peace likely against a rival — and even then it's still pricier than fleeing if the player has the speed.

**Concern:** "negotiate" is the explanatory option ("avoid violence, pay your way out") but is rarely the dominant strategy. The merc autopilot's choice path is correct (fight if competent, otherwise flee), but a player who reads "negotiate" as "the safe choice" will lose more credits than the alternative on average.

---

## 6. NPC fleet — how combat affects the simulated economy

24,064 NPC encounters across three baselines. **Total NPC drain: Ç0 credits, 0 cargo units, 0 recorded hull damage.** Outcome distribution:

```
NPC encounter outcomes (3 baselines pooled, n=24,064)
  flee · escaped       11,755   48.8%  ▓▓▓▓▓▓▓▓▓▓▓▓
  flee · fled_damaged  12,309   51.2%  ▓▓▓▓▓▓▓▓▓▓▓▓▓
  fight · won               0    0.0%
  fight · lost              0    0.0%
  negotiate · *             0    0.0%
```

Why 100% flee? `autopilotPolicy` for an NPC (no mercenary) checks:
1. `pFight ≥ 0.55` → no, NPC weaponPower=0 vs attacker 1-7 makes pFight ≈ 0.30
2. `pNegotiate ≥ 0.50 AND funds ≥ bribe` → no, pNegotiate is fixed at 0.45 for pirates
3. fall through → flee

Because hull damage rounds to 0 on `fled_damaged` for hull≤4 ships, and credits/cargo only deplete on `lost` or `negotiated_partial` (both gated behind autopilot choices NPCs never make), the system has **no measurable economic effect on NPC traders today**.

This is a design choice or a bug depending on intent:
- **As atmosphere:** ✓ — heatmap is rich, ledger feed is busy, ships occasionally take a tiny chip.
- **As soft-cap on NPC wealth:** ✗ — `chargeNpcWealthCarry` is doing all the work; combat contributes nothing.
- **As danger signaling:** middling — heat lights up red, but veteran players will figure out NPC ships never actually die from it.

Recommendation if we want combat to bite for NPCs:
1. Lower `AUTO_NEGOTIATE_MIN_P` to 0.40 so pirate-flee occasionally diverts to a small-cargo bribe.
2. Stop rounding flee hull to 0 — use `Math.max(1, ...)` or store fractional hull.
3. Or: leave atmospheric and lean into the visual story; just be honest about it.

### 6b. Player vs NPC, by configuration

Same-seed 4,000-tick runs, player set to pilot=npc to drive trade. Player ship gets few encounters because it makes ~13-14 trips to NPC's 80 trips per ship over the same window:

```
                              encounters    drain (Ç)   destroyed
player default                 13           0           0
player + tier-3 merc           13           25,000      0   (1 lost fight)
player armed (hull 30, w 12)   13           0           1   (cumulative flee dmg killed it)
player armed + merc            14           49,220      0   (2 lost fights, mostly won)
```

Two nuances worth surfacing:
- **The "armed" config dies on cumulative flee damage** because `autopilotPolicy` still says flee (no merc → no fight). 13 fled_damaged events × 30·0.10 = 39 hull lost → ship at 0. If we want hardpoints to matter without a merc, the policy needs to consider weapon power directly, or hull repair needs to be cheaper / automatic.
- **Merc-only** (no extra hull/weapon) yields 12 wins, 1 loss across 13 fights. Tier-3 merc gives `+12 weaponPower`, which against an attacker rolling weapon ≈ 3 is `tanh(9/8)·0.4 + 0.5 ≈ 0.83 pFight` — outcome data confirms it (~92% wins). The merc is the strongest single combat upgrade today.

---

## 7. Lane heat / atlas integration

Top 10 lanes by encounter count, baseline seed 1001 (4,000 ticks):

```
bountiful_vault → crossroads_hub          661 ████████████████████ 100%
lantern_rim → meadow_bloom                651 ███████████████████▌  98%
cinder_reach → high_beacon_drift          477 ██████████████░░░░░░  72%
meridian_station → south_fertile_canopy   411 ████████████░░░░░░░░  62%
plaza_hub → pyre_outpost                  361 ███████████░░░░░░░░░  55%
greenfield_ring → quarry_works            278 ████████░░░░░░░░░░░░  42%
high_vein_hold → meadow_bloom             220 ██████░░░░░░░░░░░░░░  33%
lower_forum_exchange → outpost_reach      212 ██████░░░░░░░░░░░░░░  32%
inner_lantern_reach → quarry_works        170 █████░░░░░░░░░░░░░░░  26%
penumbra_bastion → plaza_hub              166 █████░░░░░░░░░░░░░░░  25%
                                              (others: 50+ lanes,
                                               long tail < 25%)
```

The hottest lane sees 4× the cold lane in the top 10. This is what feeds the atlas's lane danger gradient (calm < 5 / med 10 / hot 20+ over a **250-tick** window). At ~16-17 encounters per 100 ticks per lane on the hot lanes, the top of the heat scale is hit easily; cold lanes barely touch "calm". That gives the atlas a real visual story.

The atlas uses two persistence layers:
- `world.encounterHistory` — capped at **500** in memory (one-game), drives live pings.
- `STORE_ENCOUNTERS` (IDB) — unbounded, paginated via the Captain's Ledger combat tab.

The 500-cap matches the design intent (heatmap window 250t × ~2 encounters/tick on busy maps fits comfortably) and was raised from 200 specifically when NPC fights joined the table.

---

## 8. News × combat — the full hand-off

A full ladder of how news touches combat:

```
1. tickNewsEvents(world)         decides "spawn an event" via cadence + bias
   └─► returns NewsSpawnRequest   (tier + biasHint + target)

2. UI store posts to /api/news/event
   └─► server returns ResolvedNewsEvent (LLM-authored effects)

3. applyResolvedNewsEvent(world, resolved)
   └─► stamps world.newsEvents.active
   └─► updates bias EMA (mean-reversion)

4. (next tick onward)
   maybeSpawnEncounter(world, ship)
   └─► encounterChance(world, ship)
       └─► p = 0.05
           + 0.015 if border + 0.015 if hostile + 4e-7×cargoVal
           × eventMultiplier(world, "encounter_chance", { locationId, syndicateId })
           clamp [0.03, 0.07]

5. eventMultiplier walks active events, multiplies each (1 + dir·mag) for matching scope/target
   └─► clamp [0.25, 4.0]
```

Telemetry comparison from synthetic injections:

```
news state           total encounters (4,000 ticks)
none (baseline)         8,007  (clamped reach: 5.0% nominal)
+60% global event       9,008  (+12.5%, ceiling clamp ate the rest)
-60% global event       4,208  (-47.4%, asymmetry due to floor at 3%)
```

Reads cleanly in-fiction: "raids spike" or "patrols are heavy this week" matches the slope; the ceiling means we can't make routes terrifying via news alone. If we want stronger spikes we'd raise `MAX_ENCOUNTER_CHANCE`, but that risks the worst-case "two encounters in three ticks" frustration the design explicitly avoids.

---

## 9. Cooldown + warmup behavior

- **Per-ship cooldown** (8 ticks): observed in the trace — across 8,007 encounters in baseline 1001, no two encounters share `(shipId, spawnedAt difference < 8)`. Cooldown is enforced.
- **World warmup** (100 ticks): bucket 0 always = 0. Bucket 1 (ticks 100-199) is the first that hits steady-state level (~225 encounters). No ramp — the gate flips cleanly at tick 100.

This behavior is what made the seeding-while-the-game-isn't-yet-live work cleanly: encounters can't fire until the player has clicked through the wizard.

---

## 10. Performance

```
ms / tick (3 baseline runs, sustained over 4,000 ticks)
    seed 1001    14.0 ms / tick
    seed 2002    16.0 ms / tick
    seed 3003    15.6 ms / tick
                 ─────
                 ~15.2 ms / tick on average
```

That's ~66 ticks/sec on this machine for a 50-loc, 100-trader world with full combat + news + market eval. Combat itself is a small slice of the cost — adding combat to the loop didn't materially change `ms/tick` from earlier audit runs. No optimization concerns.

---

## 11. Risks and follow-ups

| # | Concern | Severity | Suggested fix |
|---|---------|----------|---------------|
| 1 | NPC encounters have **0 economic impact** (round-to-zero hull, no fight/negotiate paths) | **medium** — undermines the "lived-in sector" thesis if a player ever audits NPC ledgers | Round flee hull to ≥1; optionally lower `AUTO_NEGOTIATE_MIN_P` so high-cargo NPCs occasionally bribe |
| 2 | Cargo-value bonus saturates at ~Ç75k for intra-syndicate routes; clamp eats the rest | low — the clamp protects against overspawn, this is by design | Document and accept; or convert cargo bonus into a band-shifted intensity instead of a chance bump |
| 3 | News can suppress (-47% real) much more than it can boost (+12% real) | low — designer can craft asymmetric narratives | Either widen `MAX_ENCOUNTER_CHANCE` or label the asymmetry in the LLM prompt so it doesn't promise spikes the math can't deliver |
| 4 | "Armed" player ship without a merc auto-pilots into death (cumulative flee dmg) | medium — confusing UX: invested in hull/weapon, still dies passively | Make `autopilotPolicy` consider raw weapon power, not just merc presence; or reduce flee hull damage on ships with weapon ≥ N |
| 5 | Negotiate is rarely optimal vs pirates (avg loss 4× a fight loss) | low — rivalry path makes negotiate good at high rep | Either tune pirate `pNegotiate` band (currently flat 0.45) or accept that pirates are "fight-or-flee" and rivals are "negotiate-friendly" |
| 6 | Player encounter rate (~13 per 4k ticks) is sparse for the harness's pilot=npc setup | informational — real player makes ~3× more trips per ship-tick than this harness simulates | Not a bug — manual play has more transit-ticks per ship and the cargo bonus actually engages |
| 7 | Rival attackers gated to player only — design call | informational | No change. Confirmed by 0 rivals on 24,064 NPC encounters |

---

## 12. Things that work cleanly (worth preserving)

- RNG seeding: outcome rates track configured `pX` to within ±2% over 2,000 trials. No bias in `mulberry32(tick⊕shipHash⊕encId)`.
- Cadence stability: 200 ± 25 encounters per 100-tick bucket from tick 100 onward. No drift, no death spirals across 4,000-tick horizons.
- Rival gate: 0/24,064 rivals on NPCs across three seeds. Player rate 28-38% inside the rival window matches the 35% design.
- Cooldown enforcement: zero observed double-spawns inside 8 ticks per ship.
- News integration: synthetic events move the dial in both directions; clamp behaves as documented.
- Hull repair, weapon-mount cap (`weapon`, `weapon_2`, `weapon_3`) ladder for cruiser/exotic, mercenary economy: all wired and functioning per the unit tests; no surprises from the trace.

---

## Appendix — reproducing

Run `HORIZON=4000 npx tsx src/sim/scenarios/combat_report.ts`. The
harness boots three baseline seeds + four player configs + two
news-modulated runs, plus the strategy Monte Carlo. JSON traces are
written to `.logics-cache/combat_report/` (gitignored):

- `world_summary.json` — one entry per scenario, top-line numbers
- `world_<scenario>.json` — full per-encounter trace (8k–9k records each)
- `strategy_results.json` — Monte Carlo: 5 profiles × 3 strategies × 2,000 trials
- `rate_grid.json` — `encounterChance(world, ship)` over (border, cargo) grid

The numbers in this report are pinned from the run that produced this
document; rerunning will give similar but not bit-identical results
(seeds are deterministic but small floating-point ordering can drift).
