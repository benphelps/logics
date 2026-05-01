# Website

`website.html` is a standalone single-page site for Logics. It is built by Vite alongside the playable game and intentionally keeps the game at `/`.

## Files

- `website.html` — HTML entry point
- `src/site/Site.tsx` — static React content for the page
- `src/site/site.css` — website styling
- `public/site/logics-mark.svg` — compact mark for small sizes and favicon use
- `public/site/logics-wordmark.svg` — horizontal wordmark for the website header/footer
- `public/site/screenshots/*.png` — gameplay screenshots used by the page

## Direction

The site presents Logics as a space logistics trading idle clicker:

- easy first action: buy cargo, ship it, sell it
- trading layer: markets, contracts, prices, and shortages
- shipping layer: cargo, fuel, lanes, maintenance, and station travel
- automation layer: crew, upgrades, auto-pilot, and passive positions
- career layer: Charters, manual-action unlocks, staged guidance, and staged automation

The public pitch should stay close to the current game direction: space trucking, coordination, and Wall Street simulation in the browser; part spreadsheet, part clicker, part idler. The visual language should stay close to the game UI: dark command panels, compact uppercase labels, cyan/amber market accents, and existing industrial space art.

## Refreshing Screenshots

Start the app with `npm run dev`, open the game, and capture these views into `public/site/screenshots/`:

- `fleet.png` — My Fleet / bridge
- `markets.png` — Markets
- `atlas.png` — Atlas
- `exchange.png` — Exchange
- `readme-fleet.png` and `readme-exchange.png` — README-specific callouts captured from the live UI

The screenshots should come from the running game UI so the site reflects the current build instead of drifting into mockups.

## Wiki Screenshots

Use the capture script for reusable wiki screenshots:

```sh
npm run screenshots:wiki
npm run screenshots:wiki:exchange
```

The script tries the common Vite ports from 5173 through 5179. Pass `--url=http://127.0.0.1:5176/` when you need a specific server. It launches a temporary headless Chrome session, loads the game's developer state, shapes it into a documentation-ready scenario for the requested wiki view, captures focused UI elements, and writes images plus `manifest.json` under that view's folder in `public/site/screenshots/wiki/`.

The wiki screenshot component uses the `focus` rectangle from the manifest to dim the surrounding image on hover while leaving the explained UI area clear. The capture script hides navigator suggestion markers in normal screenshots and leaves them visible in the dedicated Suggestions capture.
