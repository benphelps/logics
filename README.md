![Ledgway gameplay screenshot](public/site/screenshots/readme-ui-composite.png)

Ledgway is a browser game about running a space trucking outfit inside a living station economy. You start with one ship, one wallet, and a simple question: what should I buy here, and where can I sell it for more?

The loop grows from hands-on cargo runs into fleet coordination, staged crew automation, ship upgrades, and a simulated market desk where the same economy can be traded through station shares, syndicates, commodities, basis pairs, futures, and indices. It is part spreadsheet, part clicker, part idler, and part Wall Street terminal for a sector you can physically move goods through.

## Gameplay

- **Run the route yourself.** Buy cargo, refuel, take contracts, travel between stations, sell into shortages, and keep the ship repaired.
- **Unlock better guidance.** Career charters track manual actions and gradually open upgrade tiers, navigator offers, mechanic offers, and pilot offers.
- **Hire a crew.** Navigators surface route and exchange suggestions, mechanics handle maintenance, and pilots let auto mode run the ship.
- **Invest in the economy.** Trade assets on the Exchange while your ships change the underlying station and commodity signals.
- **Build toward scale.** Current systems support the direction toward buying more ships, moving into larger hulls, assigning crews, and earning from established teams while you focus on bigger opportunities.

## Current Build

The game currently includes:

- A deterministic single-player logistics economy with stations, goods, treasuries, NPC traders, contracts, fuel, maintenance, taxes, and docking fees.
- Manual ship control through **My Fleet** with route-aware suggestions once a navigator is hired.
- Ship-local wallets, cargo, fuel, upgrades, crew, contracts, and auto-pilot mode.
- Career **Charters** that gate upgrade tiers and crew offer pools through manual-action milestones.
- A full **Exchange** with spot-style listings, order books, player positions, limit orders, futures, history, dividends, borrow fees, settlement jobs, and navigator trade insights.
- **Markets** and **Atlas** tabs for commodity pressure, station context, ships, routes, and news.
- Local save slots and a developer state for screenshot/documentation capture.

Planned additions include buying new ships, controlling more than one ship, larger hull classes with traits, dangerous route work, combat-relevant jobs, actual weapon upgrades, and higher-stakes fleet/market automation.

## Run Locally

```sh
npm install
npm run dev
```

Open the Vite URL for the playable game. The marketing page is available at `/website.html`, and the player wiki is available at `/wiki.html`.

Useful checks:

```sh
npm test
npm run build
npm run audit
npm run screenshots:wiki
```

## Project Layout

```text
src/sim/                    deterministic TypeScript simulation
src/ui/                     playable React app
src/site/                   website and wiki React surfaces
docs/                       design docs, roadmap, simulation notes, wiki source
public/site/screenshots/    public UI screenshots
scripts/                    screenshot and scenario tooling
```

Key docs:

- [Vision](docs/VISION.md)
- [Roadmap](docs/ROADMAP.md)
- [Simulation Model](docs/SIM.md)
- [Player Wiki](docs/WIKI.md)
- [Website Notes](docs/WEBSITE.md)
