# Upgrades rework — variety + flavor + new mechanics

The original catalog had 18 upgrades stacked as boring 3-tier ladders
("Cargo Bay Extension I/II/III"). This rework replaces that with a
broader family tree: each slot gets multiple distinct variants per
tier so picking a build is a real choice, and names lean on flavor
instead of the tier numeral.

## Phase A — data + flavor (no new mechanics)

- [x] Add an optional `description` blurb on `ShipUpgradeDef` for
  later UI surfacing. Drop redundant roman numerals from existing
  names — the `tier` numeric drives the stars.
- [x] Add ~14 new variants across cargo / engine / fuel / hull /
  weapons / systems. Each new entry uses only existing
  `CrewModifiers` keys (`cargoCapacityBonus`, `fuelCapacityBonus`,
  `speedBonus`, `hullBonus`, `weaponPowerBonus`, `rangeEfficiency`,
  `unloadSpeedBonus`, `instantUnload`, `remoteSettlementCollection`,
  `instantTravel`, `fuelFreeTravel`, `maintenanceDiscount`,
  `contractRewardBonus`).
- [x] Add corresponding entries in `data/goods.ts` (price + weight).
- [x] Seed the new variants at tech-appropriate stations in
  `data/locations.ts` so they actually show up at markets.
- [x] Existing upgrade IDs are preserved verbatim — tests still pass.

### New families per slot

- **Cargo** — Standard / Heavy Hauler (caps), Modular Container Bay
  (small + faster unload), Smuggler's Compartment (cap + maintenance
  discount), Atlas Hauler Spine (max cap), Rapid Cargo Lift
  (existing), Zero-G Unload Matrix (existing).
- **Engine** — Vector Thrusters / Slipstream Drive / FTL Fold Drive
  (existing speed ladder), Solar Sail Rig (efficient slow), Microjump
  Coil (speed + maintenance), Singularity Burst Drive (top speed sans
  fold).
- **Fuel** — Fuel Reclaimer / Hydrogen Spinner / Zero-Point Core
  (existing), Solar Bloom Collector (efficient small), Auxiliary Tank
  Lattice (huge cap), Bio-Reactor Stack (massive efficiency without
  fuel-free).
- **Hull** — Reinforced Plating / Composite Battle Plating / Adamant
  Carapace (existing), Ablative Plate Layers (mid-tier maint), Photon
  Damping Coat (light + contracts), Self-Repair Nanite Mesh (T3 maint
  focus).
- **Weapons** — Pulse Cannon / Quad Gauss / Plasma Lance (existing),
  Point-Defense Lattice (T1 + maint), Bounty Hunter Rig (T2 +
  contracts), EMP Disruptor Array (T3 + range).
- **Systems** — Survey Computer / Exchange Relay / Oracle Trade Core
  (existing), Haggler's Earpiece (T1 contracts), Bridge Ticker Tape
  (T2 watcher), Pressure Atlas Console (T3 contracts + maint).

## Phase B — new mechanics (later)

- New `CrewModifiers` keys: `fuelRegenIdle` (passive top-up at dock),
  `dockingDiscount` (% off docking fee), `treasuryYield` (idle
  interest on cash), `dividendBonus` (% bump on equity payouts),
  `routeReveal` (visibility into far stations' contracts).
- Wire each through the relevant sim path with tests.
- Extend `upgradeEffectText` to render the new effect strings.

## Phase C — UI

- Group upgrade variants by `(slot, tier)` family in the market /
  upgrades panel so the player can compare side-by-side.
- Render the `description` blurb on hover or expansion.
- Show "currently installed" + "would replace" at-a-glance.

## Notes

- `buyDiscount` and `sellPremium` modifiers are wired in the type
  but flagged "NOT YET WIRED" in `types.ts`. Phase A skips them
  entirely. Phase B can wire them up if we keep the design.
- `contractRewardBonus` is also flagged "NOT YET WIRED" but already
  appears on existing upgrades, so we treat it as in-flight design
  and reuse it.
- Several existing upgrade IDs are referenced from station seeds and
  archetypes (`data/locations.ts`, `gen/archetypes.ts`). To avoid
  ripple churn, IDs are preserved verbatim; only `name` and the new
  variants change.
