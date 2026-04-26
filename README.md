# Logics

A spreadsheet-style, single-player browser game where a dense market simulation is the primary thing you interact with — not a backdrop. You run a fleet across a small universe of stations; the universe is already running an economy with NPC traders moving goods between specialized ports, and you make money by reading the same numbers they're reading.

Currently: the simulation layer. No UI yet, no player. The sim is a pure TypeScript module that runs headless under `vitest` and a CLI scenario harness.

## Stack

- Vite + React + TypeScript (UI scaffold; not yet built)
- Zustand + TanStack Table (planned, for the dense grid UI)
- Vitest for the sim test suite
- `tsx` for the headless scenario harness

## Run

```sh
npm install
npm test          # run all sim tests (≈65 tests, ~0.3s)
npm run sim 500   # run the headless economy for 500 ticks, print state
npm run dev       # Vite dev server (UI shell only — no game yet)
```

## Where things live

```
src/sim/                          pure TS sim, no React
  types.ts                        Goods, Locations, Markets, Traders, World
  pricing.ts                      price = base × clamp((target/stock)^0.6, 0.25, 5)
  economy.ts                      maintenance + stockpile cap (anti-drift)
  geometry.ts                     distance(a, b) = euclidean × laneModifier
  locations.ts                    net production + trait-based queries
  traders.ts                      NPC arbitrage with multi-fuel
  tick.ts                         orchestrates: trade → produce → consume → reprice → maintenance
  data/                           starter universe content
  scenarios/run.ts                CLI harness — `npm run sim`
  *.test.ts                       65 tests across 8 files
```

## Docs

- [`docs/VISION.md`](docs/VISION.md) — what the game is, what it isn't, the design pillars
- [`docs/SIM.md`](docs/SIM.md) — current simulation model in detail (economy, geometry, ships, supply chains)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's done, what's queued, what's deferred, and what we've discussed but parked
