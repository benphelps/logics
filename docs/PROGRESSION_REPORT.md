# Progression Audit — Director Report

_2026-04-30 21:14:26 UTC · 5 seeds × 8,000 ticks_

## TL;DR

- **43/43** upgrades become reachable inside 8,000 ticks; **12** are installed in >50% of seeds; **0** never reachable.
- Pilot autopilot gates at **t=1,972** — the single biggest pacing wall. Until then, the player has no path to the captain-led trade loop.
- Final median ship funds: **Ç1.33M** at t=8,000. Wealth growth is healthy through t≈3000, then flattens.
- Variant pricing is **broken**: many T1/T2 variants priced just above a cheaper sibling are never purchased.
- 3 pacing dead zones identified (gaps ≥400 ticks).

## Methodology

An autopilot-driven player ship runs from t=0 across 5 world seeds (1 starter universe, 4 generated 12-location worlds, all starting at a trade-hub). A synthetic zero-cost captain is slotted on the audit ship so the autopilot can drive. Each tick, the audit:

1. Repairs maintenance debt above Ç5k.
2. Records affordability of every visible hire offer; hires real crew when funds permit.
3. Climbs the upgrade ladder one rung per slot per tick, only when funds > price + Ç25k buffer, never before t=50.
4. Records every upgrade's first-affordable, first-reachable, and first-installed tick.

Aggregates are medians across seeds. "Reachable" = funds AND idle at a station that stocks the item. "Affordable" ignores location.

## Per-slot tier ladder (ASCII)

```
        0  ········································  8,000
cargo   |2   4   3                               |  tiers reached: 1/2/3/4
engine  |2    3       4                          |  tiers reached: 1/2/3/4
fuel    |2  3       4                            |  tiers reached: 1/2/3/4
hull    |2  4    3                               |  tiers reached: 1/2/3/4
weapon  |2   3                                   |  tiers reached: 1/2/3/4
systems |2      3       4                        |  tiers reached: 1/2/3/4
```

(See HTML report for richer charts.)

## Findings

### Variant cannibalization — 17 upgrades effectively dead on arrival

_Severity: high_

Within each (slot × tier), the auto-buyer always climbs to the cheapest rung first. Variants priced even slightly higher than their slot+tier sibling never get bought. Examples:
  • Modular Container Bay (Ç11,500, install 0%) loses to Standard Cargo Bay (Ç8,000, install 80%)
  • Rapid Cargo Lift (Ç42,000, install 0%) loses to Heavy Hauler Frame (Ç24,000, install 100%)
  • Smuggler's Compartment (Ç38,000, install 0%) loses to Heavy Hauler Frame (Ç24,000, install 100%)
  • Zero-G Unload Matrix (Ç110,000, install 0%) loses to Megahauler Conversion (Ç64,000, install 40%)
  • Solar Sail Rig (Ç13,500, install 0%) loses to Vector Thrusters (Ç10,000, install 100%)
  • Microjump Coil (Ç34,000, install 0%) loses to Slipstream Drive (Ç30,000, install 100%)

### Captain wall: autopilot doesn't open until t=1,972

_Severity: high_

Pilot T1 hire cost (Ç140,000) gates the entire autopilot loop. With "good play" the autopilot synthetic captain reached funds parity at this tick; without the synthetic, real players are slower because manual play < autopilot. That's roughly 30+ minutes of trading at 1 tick/sec before the loop opens.

### 3 pacing dead zones (≥400 ticks with no new unlock)

_Severity: med_

  • t=1168 → t=1598 (Δ430)  between "mechanic T2" → "Pressure Atlas Console"
  • t=2723 → t=3178 (Δ455)  between "Zero-G Unload Matrix" → "Oracle Trade Core"
  • t=3439 → t=4320 (Δ881)  between "captain T2" → "captain T3"

### Captain T3 looks like dead loot

_Severity: low_

Captain T3 median offer Ç422,400; affordable at t=4,320 but never hired in any seed within 8000 ticks. Either players never accumulate enough surplus, or the upgrade-vs-crew ROI tradeoff makes T3 captain worse than two T2 hires.

### Captain T2 also never hired

_Severity: low_

Even at the affordable tick, the auto-buyer never picked up Captain T2 — a pattern worth scrutinising. Likely cause: the audit's hiring policy stops upgrading captain after the first hire (T1), and your players might do the same.

## Recommendations

### Differentiate variants — make the price gap match a real choice

Today the variants share a slot+tier and the cheaper option dominates. Either (a) drop the loser variants' price ~10–15% below the canonical to give them a real reason to exist as the budget pick, or (b) lift their effects with a clearly distinct stat profile (e.g., Modular Container Bay sacrifices capacity for unload speed — make that tradeoff matter for late-game players). The current pricing makes 15+ items shelf decoration.

### Make autopilot reachable in the first session

Drop T1 captain hireCost from Ç140,000 → ~Ç80k–Ç100k, OR introduce a Tier-0 "rookie pilot" at Ç40k–Ç50k that unlocks autopilot with reduced effects (no contract bonus, no speed bonus). Either lands captain-pilot in the first hour-of-play instead of after.

### Compress the upper price band

26/43 upgrades install in <20% of seeds, mostly clustered Ç80k+. The wealth curve doesn't grow fast enough to keep up with the price ladder past T2. Either (a) cut top-tier prices ~25% so they unlock by t≈3000, or (b) introduce a "trade volume" multiplier so late-game runs scale faster.

### Add filler unlocks to break long stretches

Each dead zone is a session-cliff: the player notices when nothing new opens for ~7+ minutes. Slot one mid-priced upgrade or hire offer into each gap (e.g., a Ç55k systems variant or a T1.5 captain). The exact items matter less than the existence of a 'next thing'.

## Appendix: full upgrade table

| T | slot | price | upgrade | effect | affordable | reachable | installed | inst% | stocked at |
|---|---|---:|---|---|---:|---:|---:|---:|---|
| 1 | fuel | Ç7,500 | Fuel Reclaimer Pump | +15 fuel · −8% fuel/dist | t=0 | t=0 | t=71 | 100% | Haven Station, Ironhold Belt, Verdant Ring |
| 1 | cargo | Ç8,000 | Standard Cargo Bay | +15 cargo | t=0 | t=0 | t=66 | 80% | Haven Station, Verdant Ring |
| 1 | hull | Ç9,000 | Reinforced Plating | +1 hull | t=0 | t=0 | t=495 | 100% | Haven Station, Ironhold Belt |
| 1 | fuel | Ç9,500 | Solar Bloom Collector | +8 fuel · −12% fuel/dist | t=0 | t=0 | never | 0% | Haven Station |
| 1 | cargo | Ç11,500 | Modular Container Bay | +8 cargo · +50% unload speed | t=0 | t=0 | never | 0% | Haven Station |
| 1 | systems | Ç12,000 | Survey Computer | +3% contracts | t=0 | t=0 | t=177 | 100% | Haven Station, Verdant Ring |
| 1 | engine | Ç13,500 | Solar Sail Rig | +0.15 speed · −10% fuel/dist | t=0 | t=0 | never | 0% | Haven Station |
| 1 | systems | Ç15,500 | Haggler's Earpiece | +5% contracts | t=0 | t=0 | never | 0% | Haven Station |
| 2 | fuel | Ç28,500 | Hyperion Bloom Reclaimer | +18 fuel · +0.5 fuel/tick docked | t=0 | t=0 | never | 0% | Haven Station |
| 2 | systems | Ç45,000 | Diplomatic Beacon | −30% docking | t=0 | t=0 | never | 0% | Haven Station |
| 2 | cargo | Ç38,000 | Smuggler's Compartment | +22 cargo · −6% maintenance | t=0 | t=11 | never | 0% | Verdant Ring |
| 2 | fuel | Ç22,000 | Hydrogen Spinner Reclaimer | +35 fuel · −18% fuel/dist | t=0 | t=27 | t=527 | 100% | Saffron Rim |
| 2 | hull | Ç26,000 | Composite Battle Plating | +2 hull · −5% maintenance | t=0 | t=27 | t=654 | 100% | Ironhold Belt, Saffron Rim |
| 1 | weapon | Ç14,000 | Point-Defense Lattice | +1 weapons · −4% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | fuel | Ç26,500 | Auxiliary Tank Lattice | +60 fuel | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | hull | Ç31,000 | Ablative Plate Layers | +3 hull · −4% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | engine | Ç34,000 | Microjump Coil | +0.4 speed · −6% maintenance | t=0 | t=29 | never | 0% | Ironhold Belt |
| 2 | weapon | Ç36,000 | Quad Gauss Battery | +3 weapons · +5% contracts | t=0 | t=30 | t=1,193 | 100% | Ironhold Belt, Saffron Rim |
| 2 | weapon | Ç41,000 | Bounty Hunter Rig | +3 weapons · +8% contracts | t=0 | t=32 | never | 0% | Ironhold Belt |
| 2 | cargo | Ç24,000 | Heavy Hauler Frame | +35 cargo | t=0 | t=41 | t=359 | 100% | Saffron Rim |
| 2 | hull | Ç29,500 | Photon Damping Coat | +1 hull · +6% contracts | t=0 | t=53 | never | 0% | Saffron Rim |
| 2 | engine | Ç30,000 | Slipstream Drive | +0.5 speed · −10% fuel/dist | t=0 | t=75 | t=1,714 | 100% | Ironhold Belt |
| 1 | engine | Ç10,000 | Vector Thrusters | +0.25 speed | t=0 | t=198 | t=422 | 100% | Ironhold Belt |
| 1 | weapon | Ç12,000 | Pulse Cannon Turret | +1 weapons | t=0 | t=198 | t=682 | 60% | Ironhold Belt |
| 2 | cargo | Ç42,000 | Rapid Cargo Lift | +10 cargo · +100% unload speed | t=0 | t=354 | never | 0% | Ironhold Belt |
| 2 | systems | Ç47,000 | Bridge Ticker Tape | +6% contracts | t=0 | t=387 | t=596 | 20% | Saffron Rim |
| 2 | systems | Ç62,000 | Bonded Treasury Module | +4% contracts · +0.08%/tick yield | t=1,159 | t=594 | never | 0% | Saffron Rim |
| 4 | hull | Ç72,000 | Self-Repair Nanite Mesh | +3 hull · −20% maintenance | t=1,184 | t=776 | t=1,085 | 20% | Saffron Rim |
| 3 | fuel | Ç82,000 | Bio-Reactor Stack | +30 fuel · −30% fuel/dist | t=1,404 | t=787 | t=801 | 20% | Verdant Ring |
| 2 | systems | Ç58,000 | Negotiator's Console | −4% buy · +4% sell | t=781 | t=921 | never | 0% | Haven Station |
| 3 | weapon | Ç86,000 | EMP Disruptor Array | +4 weapons · −10% fuel/dist | t=1,447 | t=992 | t=1,152 | 20% | Saffron Rim |
| 4 | cargo | Ç88,000 | Atlas Hauler Spine | +90 cargo | t=1,704 | t=992 | t=1,107 | 20% | Saffron Rim |
| 4 | weapon | Ç90,000 | Plasma Lance Array | +6 weapons · +10% contracts | t=1,704 | t=992 | t=1,502 | 20% | Saffron Rim |
| 3 | engine | Ç105,000 | Singularity Burst Drive | +1.4 speed | t=1,793 | t=1,106 | never | 0% | Saffron Rim |
| 3 | systems | Ç118,000 | Pressure Atlas Console | −6% maintenance · +10% contracts | t=1,838 | t=1,598 | t=1,621 | 20% | Saffron Rim |
| 3 | systems | Ç124,000 | Shareholder Relations Suite | +0.05%/tick yield · +12% dividends | t=1,886 | t=1,599 | never | 0% | Saffron Rim |
| 2 | systems | Ç55,000 | Exchange Relay | remote exchange collection | t=0 | t=1,715 | t=2,074 | 80% | Ironhold Belt |
| 3 | cargo | Ç64,000 | Megahauler Conversion | +60 cargo | t=1,168 | t=1,718 | t=1,922 | 40% | Saffron Rim |
| 3 | hull | Ç70,000 | Adamant Carapace | +4 hull · −10% maintenance | t=1,177 | t=1,755 | t=2,387 | 40% | Saffron Rim |
| 4 | fuel | Ç90,000 | Zero-Point Fuel Core | +60 fuel · fuel-free travel | t=1,704 | t=2,386 | t=2,789 | 40% | Saffron Rim |
| 4 | engine | Ç95,000 | FTL Fold Drive | +1 speed · FTL instant travel | t=1,734 | t=2,702 | t=2,985 | 40% | Ironhold Belt |
| 3 | cargo | Ç110,000 | Zero-G Unload Matrix | +20 cargo · instant unload | t=1,814 | t=2,723 | never | 0% | Saffron Rim |
| 4 | systems | Ç130,000 | Oracle Trade Core | remote exchange collection · +3% sell · +12% contracts | t=1,945 | t=3,178 | t=3,458 | 40% | Saffron Rim |

## Appendix: crew table

| role | T | median offer | median unlock-price | affordable | hired | hire % | offers seen |
|---|---|---:|---:|---:|---:|---:|---:|
| captain | 1 | Ç140.0k | Ç140.0k | t=1,972 | t=2,082 | 100% | 8,196 |
| captain | 2 | Ç228.0k | Ç228.0k | t=3,439 | never | 0% | 9,089 |
| captain | 3 | Ç422.4k | Ç416.4k | t=4,320 | never | 0% | 5,567 |
| mechanic | 1 | Ç40.0k | Ç40.0k | t=54 | t=714 | 100% | 12,841 |
| mechanic | 2 | Ç70.5k | Ç63.6k | t=1,168 | never | 0% | 14,511 |
| mechanic | 3 | Ç164.4k | Ç127.0k | t=2,037 | never | 0% | 7,510 |
| navigator | 1 | Ç18.0k | Ç18.0k | t=29 | t=29 | 100% | 22,066 |
| navigator | 2 | Ç45.0k | Ç42.8k | t=306 | never | 0% | 22,109 |
| navigator | 3 | Ç140.4k | Ç124.8k | t=1,959 | never | 0% | 11,741 |

---

_Generated by `npm run audit:progression` (`src/sim/scenarios/progression_audit.ts`). Re-run after any pricing change to compare._
