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

## Phase B — new mechanics (done)

- [x] New `CrewModifiers` keys: `dockingDiscount` (% off docking fee),
  `fuelRegenIdle` (passive fuel top-up while docked), `treasuryYield`
  (per-tick interest on idle ship funds), `dividendBonus` (% bump on
  long-position dividend payouts).
- [x] Wired the previously-unused keys: `buyDiscount` (cuts buy price
  at `buyAtLocation`), `sellPremium` (raises unitPrice into
  `settleSale`), `contractRewardBonus` (folds into both
  `creditJobOnDelivery` and `collectExchangeSettlement`).
- [x] Per-tick `applyIdlePerks` runs alongside `chargeMaintenance`,
  iterates idle traders, applies fuel regen and treasury yield. Yield
  is sourced from the dock's market treasury (float-conserved);
  dividend bonus is paid on top of the base payout (small subsidy).
- [x] `upgradeEffectText` extended for all new keys.
- [x] Five new upgrade variants exercising the new effects:
  *Hyperion Bloom Reclaimer* (fuel regen), *Bonded Treasury Module*
  (treasury yield), *Diplomatic Beacon* (docking discount),
  *Shareholder Relations Suite* (dividend bonus), *Negotiator's
  Console* (buy discount + sell premium).
- [x] Per-effect tests (7 new) — full suite 303 tests green.

`routeReveal` deferred — it's a visibility/UI hook rather than a sim
effect; better suited to phase C.

## Phase C — UI (done)

- [x] Group upgrade cards by slot in both the cargo-modules section
  (Ship Upgrades tab) and the station purchase tab — each slot gets
  its own small-caps section title and grid of variants. Variants
  within a slot sort by tier ascending.
- [x] Render the `description` blurb on each card under the name
  (italic, dim).
- [x] Inline "replaces X" hint on cargo cards when installing would
  displace an already-installed module — pairs with the existing
  Replace button label so the player sees both before clicking.

## Notes

- `compareUpgradeGoods` was re-sorted to slot-first so the catalog
  reads naturally regardless of which renderer consumes it.
- `routeReveal` is still deferred — it would fit best in phase D as a
  visibility unlock on the atlas/contracts views.

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
