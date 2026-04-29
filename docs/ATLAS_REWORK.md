# Atlas rework — design + functionality alignment with the stock view

Goal: bring the LocationsView ("atlas") in line with the patterns that
worked in StockMarketView — fleet-style art-backed panel heads,
trade-helper-section content blocks, single-open accordions, and richer
table data — plus add live ship plotting and basic interactivity to the
sector map.

Source data already on hand:
- `Trader.location` is the origin during transit and the current dock
  while idle. `destination` is the next hop, `ticksRemaining` counts down
  to arrival, `speed` + `routeDistance(location, destination)` rebuild
  the trip's total ticks so we can compute progress = `1 - ticksRemaining
  / totalTicks` along that lane.
- `world.lanes` carries the lane graph; `routeSegments(world)` returns
  the visible edges. `world.jobs` carries open contracts. `world.markets`
  carries per-good prices and stock; `netProductionRate(loc, good)`
  returns the per-tick production/consumption signal.

## Phase 1 — bigger map, ship plotting, fleet-style detail panel

- [x] Track ship positions on the map: idle ships clustered around their
  station, transit ships along their lane interpolated from
  `ticksRemaining` / total. Player ship gets a distinct marker.
- [x] Lane traffic heatmap: line opacity scales with the count of ships
  in transit along that segment so busy corridors read at a glance.
- [x] Mouse interactions: pan with drag, zoom with wheel (clamped),
  reset-on-double-click. Hover tooltip on stations, ships, and lanes.
- [x] Selection: click a station, ship, or lane to set focus. Selecting
  a ship pins its row in the right column.
- [x] Right column re-skin: art panel head matching `.atlas-panel-head.
  art-panel-head`, `trade-helper-grid` KPIs (population / tech / docked
  + inbound / open contracts / market pressure summary), market table
  in the same trade-helper-line pattern.
- [x] New "Traffic" subsection in the right column listing docked and
  inbound ships using a single-open accordion row pattern (mirrors the
  Positions/Orders accordions).
- [x] Station table: replace the freeform "Pressure" cell with concrete
  numeric columns — short/surplus counts, avg `price/base` skew, and a
  fleet-activity column (`docked + inbound` with subtitle splitting
  the two), all with a small caps header row that matches stocks.

## Phase 2 — second pass

- Per-ship accordion expansion (route preview, ETA, cargo manifest,
  contract acceptance, retarget control).
- Lane traffic by direction (split the line into outbound vs inbound
  per ship, color-coded).
- Filter chips (faction / kind / has-shortage) above the table.

## Notes / decisions

- Total transit ticks aren't stored, only `ticksRemaining`. Recompute
  via `routeDistance / speed` on every render — same formula
  `traders.ts` uses when starting a hop, so this stays in sync.
- Ship plotting interpolates linearly between projected station
  coordinates. We're not drawing a curved arc; if lanes get curvy in
  the future the projector should stay the single source of truth.
