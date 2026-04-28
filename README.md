# Logics

A spreadsheet-style, single-player browser game where a dense market simulation is the primary thing you interact with — not a backdrop. You run a fleet across a small universe of stations; the universe is already running an economy with NPC traders moving goods between specialized ports, and you make money by reading the same numbers they're reading. On top of the goods market sits an equity exchange where every station and a handful of NPC syndicates trade as listed companies you can go long or short.

## Stack

- Vite + React + TypeScript (dense-grid UI)
- Zustand + TanStack Table for the grid views
- Vitest for the sim test suite
- `tsx` for the headless scenario harnesses

## Run

```sh
npm install
npm test               # run all sim tests (247 tests, ~22s)
npm run sim 500        # run the starter universe for 500 ticks, print state
npm run audit          # long-horizon stability + stock-market audit (default 10k ticks)
npm run audit -- 25000 # 25k-tick audit
npm run bench          # scale benchmark: 10 → 1000 locations, ms/tick
npm run dev            # Vite dev server (full UI)
```

## Where things live

```
src/sim/                          pure TS sim, no React
  types.ts                        Goods, Locations, Markets, Traders, Player, Equities, World
  pricing.ts                      price = base × clamp((target/stock)^0.6, 0.25, 5)
  economy.ts                      maintenance, stockpile cap, treasuries, NPC wealth carry
  geometry.ts                     distance(a, b) = euclidean × laneModifier
  locations.ts                    net production + trait-based queries
  traders.ts                      NPC arbitrage with multi-fuel; closed-loop money via treasuries
  jobs.ts                         shortage contracts + rescue calls
  hires.ts                        per-station crew offer pool
  crew.ts                         crew modifiers + auto-pilot gating + maintenance debt
  upgrades.ts                     ship modules + slot system
  suggestions.ts                  manual-mode hint engine
  stock.ts                        equity exchange: stations + syndicates, long/short, stop/take, dividends
  tick.ts                         orchestrates: trade → produce → consume → reprice → maint → carry → treasury → market → jobs → hires
  data/                           starter universe content
  scenarios/run.ts                short scenario printout — `npm run sim`
  scenarios/audit.ts              long-horizon audit harness — `npm run audit`
  scenarios/bench.ts              scale benchmark — `npm run bench`
  gen/                            seeded archetype-based world generator
  *.test.ts                       247 tests across 14 files
src/ui/                           Vite/React app
  views/MarketsView.tsx           commodity exchange grid
  views/LocationsView.tsx         atlas
  views/PlayerView.tsx            bridge / fleet management
  views/StockMarketView.tsx       equity exchange (tape, positions, trades, sidebar trade controls)
  store.ts                        zustand store with sim actions
  saveGames.ts                    localStorage persistence + migration
```

## Docs

- [`docs/VISION.md`](docs/VISION.md) — what the game is, what it isn't, the design pillars
- [`docs/SIM.md`](docs/SIM.md) — current simulation model in detail (economy, geometry, ships, supply chains, treasuries, equity exchange)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's done, what's queued, what's deferred, and what we've discussed but parked
- [`docs/AUDIT_REPORT.md`](docs/AUDIT_REPORT.md) — before/after metrics for the Tier-3 stability + stock market work
