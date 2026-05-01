# Progression Audit — Director Report

_2026-05-01 01:03:29 UTC · 5 seeds × 8,000 ticks_

## TL;DR

- **43/43** upgrades become reachable inside 8,000 ticks; **12** are installed in >50% of seeds; **0** never reachable.
- Pilot autopilot gates at **t=1,787** — the single biggest pacing wall. Until then, the player has no path to the captain-led trade loop.
- Final median ship funds: **Ç744.3k** at t=8,000. Wealth growth is healthy through t≈3000, then flattens.
- Variant pricing is **broken**: many T1/T2 variants priced just above a cheaper sibling are never purchased.
- 4 pacing dead zones identified (gaps ≥400 ticks).

## Methodology

**Two-layer pacing.** Progression gates on TWO axes: a manual-action counter (50 actions for navigator's guild, 250 for autopilot, etc.) AND price affordability. This audit measures the second layer only — milestones are pre-unlocked at the start of each seed so we can isolate the price ladder. Real pacing is whichever gate is harder for a given item.

**Run setup.** Autopilot-driven player ship runs from t=0 across 5 world seeds (1 starter universe, 4 generated 12-location worlds, all starting at a trade-hub). A synthetic zero-cost captain is slotted on the audit ship so the autopilot can drive. Each tick, the audit:

1. Repairs maintenance debt above Ç5k.
2. Records affordability of every visible hire offer; hires real crew when funds permit.
3. Climbs the upgrade ladder one rung per slot per tick, only when funds > price + Ç25k buffer, never before t=50.
4. Records every upgrade's first-affordable, first-reachable, and first-installed tick.

Aggregates are medians across seeds. "Reachable" = funds AND idle at a station that stocks the item. "Affordable" ignores location.

## Per-slot tier ladder (ASCII)

```
        0  ········································  8,000
cargo   |2   34                                  |  tiers reached: 1/2/3/4
engine  |2    43                                 |  tiers reached: 1/2/3/4
fuel    |2   34                                  |  tiers reached: 1/2/3/4
hull    |2   4                                   |  tiers reached: 1/2/3/4
weapon  |2    3                                  |  tiers reached: 1/2/3/4
systems |2        3 4                            |  tiers reached: 1/2/3/4
```

(See HTML report for richer charts.)

## Findings

### Variant cannibalization — 15 upgrades effectively dead on arrival

_Severity: high_

Within each (slot × tier), the auto-buyer always climbs to the cheapest rung first. Variants priced even slightly higher than their slot+tier sibling never get bought. Examples:
  • Modular Container Bay (Ç11,500, install 0%) loses to Standard Cargo Bay (Ç8,000, install 100%)
  • Rapid Cargo Lift (Ç42,000, install 0%) loses to Heavy Hauler Frame (Ç24,000, install 80%)
  • Smuggler's Compartment (Ç38,000, install 0%) loses to Heavy Hauler Frame (Ç24,000, install 80%)
  • Solar Sail Rig (Ç13,500, install 0%) loses to Vector Thrusters (Ç10,000, install 80%)
  • Microjump Coil (Ç34,000, install 0%) loses to Slipstream Drive (Ç30,000, install 80%)
  • Solar Bloom Collector (Ç9,500, install 0%) loses to Fuel Reclaimer Pump (Ç7,500, install 100%)

### Captain wall: autopilot doesn't open until t=1,787

_Severity: high_

Pilot T1 hire cost (Ç90,000) gates the entire autopilot loop. With "good play" the autopilot synthetic captain reached funds parity at this tick; without the synthetic, real players are slower because manual play < autopilot. That's roughly 30+ minutes of trading at 1 tick/sec before the loop opens.

### 4 pacing dead zones (≥400 ticks with no new unlock)

_Severity: med_

  • t=248 → t=650 (Δ402)  between "Pulse Cannon Turret" → "Bridge Ticker Tape"
  • t=1298 → t=1787 (Δ489)  between "Zero-G Unload Matrix" → "captain T1"
  • t=2749 → t=3150 (Δ401)  between "mechanic T3" → "navigator T3"
  • t=3150 → t=3794 (Δ644)  between "navigator T3" → "captain T3"

### Captain T3 looks like dead loot

_Severity: low_

Captain T3 median offer Ç306,000; affordable at t=3,794 but never hired in any seed within 8000 ticks. Either players never accumulate enough surplus, or the upgrade-vs-crew ROI tradeoff makes T3 captain worse than two T2 hires.

### Captain T2 also never hired

_Severity: low_

Even at the affordable tick, the auto-buyer never picked up Captain T2 — a pattern worth scrutinising. Likely cause: the audit's hiring policy stops upgrading captain after the first hire (T1), and your players might do the same.

## Recommendations

### Differentiate variants — make the price gap match a real choice

Today the variants share a slot+tier and the cheaper option dominates. Either (a) drop the loser variants' price ~10–15% below the canonical to give them a real reason to exist as the budget pick, or (b) lift their effects with a clearly distinct stat profile (e.g., Modular Container Bay sacrifices capacity for unload speed — make that tradeoff matter for late-game players). The current pricing makes 15+ items shelf decoration.

### Make autopilot reachable in the first session

Drop T1 captain hireCost from Ç90,000 → ~Ç80k–Ç100k, OR introduce a Tier-0 "rookie pilot" at Ç40k–Ç50k that unlocks autopilot with reduced effects (no contract bonus, no speed bonus). Either lands captain-pilot in the first hour-of-play instead of after.

### Compress the upper price band

31/43 upgrades install in <20% of seeds, mostly clustered Ç80k+. The wealth curve doesn't grow fast enough to keep up with the price ladder past T2. Either (a) cut top-tier prices ~25% so they unlock by t≈3000, or (b) introduce a "trade volume" multiplier so late-game runs scale faster.

### Add filler unlocks to break long stretches

Each dead zone is a session-cliff: the player notices when nothing new opens for ~7+ minutes. Slot one mid-priced upgrade or hire offer into each gap (e.g., a Ç55k systems variant or a T1.5 captain). The exact items matter less than the existence of a 'next thing'.

## Appendix: full upgrade table

| T | slot | price | upgrade | effect | affordable | reachable | installed | inst% | stocked at |
|---|---|---:|---|---|---:|---:|---:|---:|---|
| 1 | fuel | Ç7,500 | Fuel Reclaimer Pump | +15 fuel · −8% fuel/dist | t=0 | t=0 | t=180 | 100% | Haven Station, Ironhold Belt, Verdant Ring |
| 1 | cargo | Ç8,000 | Standard Cargo Bay | +15 cargo | t=0 | t=0 | t=166 | 100% | Haven Station, Verdant Ring |
| 1 | hull | Ç9,000 | Reinforced Plating | +1 hull | t=0 | t=0 | t=318 | 100% | Haven Station, Ironhold Belt |
| 1 | fuel | Ç9,500 | Solar Bloom Collector | +8 fuel · −12% fuel/dist | t=0 | t=0 | never | 0% | Haven Station |
| 1 | cargo | Ç11,500 | Modular Container Bay | +8 cargo · +50% unload speed | t=0 | t=0 | never | 0% | Haven Station |
| 1 | systems | Ç12,000 | Survey Computer | +3% contracts | t=0 | t=0 | t=398 | 100% | Haven Station, Verdant Ring |
| 1 | engine | Ç13,500 | Solar Sail Rig | +0.15 speed · −10% fuel/dist | t=0 | t=0 | never | 0% | Haven Station |
| 1 | systems | Ç15,500 | Haggler's Earpiece | +5% contracts | t=0 | t=0 | never | 0% | Haven Station |
| 2 | fuel | Ç28,500 | Hyperion Bloom Reclaimer | +18 fuel · +0.5 fuel/tick docked | t=0 | t=0 | t=564 | 20% | Haven Station |
| 2 | systems | Ç45,000 | Diplomatic Beacon | −30% docking | t=0 | t=0 | t=763 | 20% | Haven Station |
| 2 | cargo | Ç38,000 | Smuggler's Compartment | +22 cargo · −6% maintenance | t=0 | t=11 | never | 0% | Verdant Ring |
| 2 | fuel | Ç22,000 | Hydrogen Spinner Reclaimer | +35 fuel · −18% fuel/dist | t=0 | t=27 | t=614 | 80% | Saffron Rim |
| 2 | hull | Ç26,000 | Composite Battle Plating | +2 hull · −5% maintenance | t=0 | t=27 | t=1,109 | 80% | Ironhold Belt, Saffron Rim |
| 1 | weapon | Ç14,000 | Point-Defense Lattice | +1 weapons · −4% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | fuel | Ç26,500 | Auxiliary Tank Lattice | +60 fuel | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | hull | Ç31,000 | Ablative Plate Layers | +3 hull · −4% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | engine | Ç34,000 | Microjump Coil | +0.4 speed · −6% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | weapon | Ç36,000 | Quad Gauss Battery | +3 weapons · +5% contracts | t=0 | t=29 | t=2,269 | 80% | Ironhold Belt, Saffron Rim |
| 2 | weapon | Ç41,000 | Bounty Hunter Rig | +3 weapons · +8% contracts | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | cargo | Ç42,000 | Rapid Cargo Lift | +10 cargo · +100% unload speed | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | engine | Ç30,000 | Slipstream Drive | +0.5 speed · −10% fuel/dist | t=0 | t=72 | t=1,607 | 80% | Ironhold Belt |
| 2 | cargo | Ç24,000 | Heavy Hauler Frame | +35 cargo | t=0 | t=85 | t=1,734 | 80% | Saffron Rim |
| 2 | hull | Ç29,500 | Photon Damping Coat | +1 hull · +6% contracts | t=0 | t=229 | never | 0% | Saffron Rim |
| 1 | engine | Ç10,000 | Vector Thrusters | +0.25 speed | t=0 | t=248 | t=491 | 80% | Ironhold Belt |
| 1 | weapon | Ç12,000 | Pulse Cannon Turret | +1 weapons | t=0 | t=248 | t=670 | 60% | Ironhold Belt |
| 2 | systems | Ç47,000 | Bridge Ticker Tape | +6% contracts | t=0 | t=650 | never | 0% | Saffron Rim |
| 2 | systems | Ç58,000 | Negotiator's Console | −4% buy · +4% sell | t=46 | t=732 | never | 0% | Haven Station |
| 2 | systems | Ç62,000 | Bonded Treasury Module | +4% contracts · +0.08%/tick yield | t=1,017 | t=817 | never | 0% | Saffron Rim |
| 3 | cargo | Ç64,000 | Megahauler Conversion | +60 cargo | t=1,105 | t=845 | t=913 | 20% | Saffron Rim |
| 3 | hull | Ç70,000 | Adamant Carapace | +4 hull · −10% maintenance | t=1,253 | t=845 | t=1,164 | 20% | Saffron Rim |
| 4 | hull | Ç72,000 | Self-Repair Nanite Mesh | +3 hull · −20% maintenance | t=1,261 | t=846 | t=1,253 | 20% | Saffron Rim |
| 3 | fuel | Ç82,000 | Bio-Reactor Stack | +30 fuel · −30% fuel/dist | t=1,702 | t=903 | t=1,051 | 20% | Verdant Ring |
| 4 | engine | Ç95,000 | FTL Fold Drive | +1 speed · FTL instant travel | t=1,763 | t=1,043 | t=2,129 | 20% | Ironhold Belt |
| 3 | weapon | Ç86,000 | EMP Disruptor Array | +4 weapons · −10% fuel/dist | t=1,708 | t=1,163 | t=1,299 | 20% | Saffron Rim |
| 4 | cargo | Ç88,000 | Atlas Hauler Spine | +90 cargo | t=1,709 | t=1,163 | t=1,609 | 20% | Saffron Rim |
| 4 | fuel | Ç90,000 | Zero-Point Fuel Core | +60 fuel · fuel-free travel | t=1,762 | t=1,163 | t=1,701 | 20% | Saffron Rim |
| 4 | weapon | Ç90,000 | Plasma Lance Array | +6 weapons · +10% contracts | t=1,762 | t=1,163 | t=1,824 | 20% | Saffron Rim |
| 3 | engine | Ç105,000 | Singularity Burst Drive | +1.4 speed | t=1,806 | t=1,297 | t=2,049 | 20% | Saffron Rim |
| 3 | cargo | Ç110,000 | Zero-G Unload Matrix | +20 cargo · instant unload | t=1,853 | t=1,298 | never | 0% | Saffron Rim |
| 3 | systems | Ç118,000 | Pressure Atlas Console | −6% maintenance · +10% contracts | t=2,427 | t=1,936 | t=2,280 | 20% | Saffron Rim |
| 3 | systems | Ç124,000 | Shareholder Relations Suite | +0.05%/tick yield · +12% dividends | t=2,457 | t=1,937 | never | 0% | Saffron Rim |
| 2 | systems | Ç55,000 | Exchange Relay | remote exchange collection | t=0 | t=2,037 | t=2,038 | 60% | Ironhold Belt |
| 4 | systems | Ç130,000 | Oracle Trade Core | remote exchange collection · +3% sell · +12% contracts | t=2,515 | t=2,234 | t=2,350 | 20% | Saffron Rim |

## Appendix: crew table

| role | T | median offer | median unlock-price | affordable | hired | hire % | offers seen |
|---|---|---:|---:|---:|---:|---:|---:|
| captain | 1 | Ç90.0k | Ç90.0k | t=1,787 | t=1,936 | 80% | 8,080 |
| captain | 2 | Ç153.0k | Ç153.0k | t=2,585 | never | 0% | 10,447 |
| captain | 3 | Ç306.0k | Ç302.4k | t=3,794 | never | 0% | 5,275 |
| mechanic | 1 | Ç40.0k | Ç40.0k | t=54 | t=54 | 100% | 11,638 |
| mechanic | 2 | Ç72.0k | Ç64.5k | t=1,251 | never | 0% | 17,135 |
| mechanic | 3 | Ç156.5k | Ç155.8k | t=2,749 | never | 0% | 10,225 |
| navigator | 1 | Ç45.0k | Ç45.0k | t=29 | t=762 | 80% | 21,031 |
| navigator | 2 | Ç85.5k | Ç79.5k | t=1,297 | never | 0% | 24,927 |
| navigator | 3 | Ç205.2k | Ç210.0k | t=3,150 | never | 0% | 14,872 |

---

_Generated by `npm run audit:progression` (`src/sim/scenarios/progression_audit.ts`). Re-run after any pricing change to compare._
