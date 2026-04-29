# Logics

An easy-to-play space logistics trading idle clicker. You start by running a single hauler: read prices, buy cargo, ship it to a better market, collect contracts, and reinvest. As the game opens up, the same choices become automated routes, crew-managed ships, upgrades, and passive market positions.

The core is still a dense single-player market simulation. Stations produce and consume goods, NPC traders move cargo, treasuries close the money loop, and an equity exchange sits on top of the goods market. The player-facing direction is simpler: clear shipping actions first, automation and optimization second.

## Website

The project includes a single-page website for presenting the game:

- `website.html` — marketing/site entry point
- `src/site/` — React + CSS for the website
- `public/site/logics-mark.svg` and `public/site/logics-wordmark.svg` — small-size logo assets
- `public/site/screenshots/` — gameplay screenshots captured from the running app

Run the Vite dev server and open `http://localhost:5173/website.html` (or the port Vite selects). The playable game remains at `index.html` / `/`.

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
src/site/                         single-page website for the game
public/site/                      website logo + gameplay screenshots
```

## Docs

- [`docs/VISION.md`](docs/VISION.md) — what the game is, what it isn't, the design pillars
- [`docs/SIM.md`](docs/SIM.md) — current simulation model in detail (economy, geometry, ships, supply chains, treasuries, equity exchange)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's done, what's queued, what's deferred, and what we've discussed but parked
- [`docs/WEBSITE.md`](docs/WEBSITE.md) — website entry point, assets, and screenshot refresh notes
- [`docs/AUDIT_REPORT.md`](docs/AUDIT_REPORT.md) — before/after metrics for the Tier-3 stability + stock market work
