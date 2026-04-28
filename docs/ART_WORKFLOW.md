# Art Workflow

This project uses subtle background art only in the info card area. Primary ship, travel, market, cargo, and station cards should stay standard UI unless the design direction changes again.

## Source Of Truth

Runtime art selection lives in `src/ui/art.ts`.

- Ships resolve by generated ship name root into a ship family, then to an image.
- Stations resolve by archetype, generated name-root subtype, and scale, then fall back to the broad archetype.
- Goods resolve by exact good id first, then category fallback.
- Upgrade goods resolve by upgrade slot.

The coverage report uses the same resolver, so update `src/ui/art.ts` before generating or judging missing art.

## Asset Layout

Project-bound images live under `public/art/`.

- `public/art/ships/` for ship family images.
- `public/art/stations/` for station archetype, subtype, and scale images.
- `public/art/goods/` for exact goods and category fallback images.
- `public/art/upgrades/` for upgrade slot fallback images.

Use stable lowercase kebab-case filenames. Prefer WebP for repo assets.

## Visual Direction

Current info-card assets should be quiet sci-fi backdrops:

- wide/cinematic framing
- subject in the upper third or upper half
- lower third dark enough for UI text overlays
- no readable text, logos, signage, or UI inside the image
- no characters unless a future inspected entity actually needs them
- restrained cool lighting, with category-appropriate accent color
- distant ships/stations rather than close-up cockpit or object shots

Prompt language that has worked well:

```text
Asset type: subtle faded UI info-card background for a sci-fi spreadsheet trading sim.
Composition: wide cinematic framing, subject in upper third/upper half, lower third dark and quiet for UI overlays.
Avoid: text, logos, signage, UI, characters, close-up cockpit, huge planet, overbright bloom.
```

## Adding New Art

1. Add or update the resolver mapping in `src/ui/art.ts`.
2. Generate the image with the built-in image tool.
3. Copy or convert the chosen output into `public/art/...`.
4. Use WebP, roughly quality `82`, unless a different format is needed.
5. Run `npm run art:coverage -- --write`.
6. Open `docs/ART_COVERAGE.md` and confirm the missing section is empty or intentionally documented.
7. Run validation before committing.

Example conversion:

```bash
cwebp -quiet -q 82 /path/to/generated.png -o public/art/stations/example.webp
```

## Coverage Report

Generate the report with:

```bash
npm run art:coverage -- --write
```

This writes `docs/ART_COVERAGE.md`.

The report checks:

- referenced asset files exist under `public/`
- every generated ship name root resolves to existing art
- the default starting universe stations resolve to existing art
- trade goods resolve to exact or fallback art
- upgrade slots resolve to existing art

If the report is below 100%, work from the missing asset list first. If a missing row is covered only by a generic fallback and that feels too repetitive in the UI, add a more specific mapping and asset.

## When Game Data Changes

When adding station name roots or suffixes:

- export them from `src/sim/gen/names.ts`
- update subtype terms in `src/ui/art.ts`
- regenerate `docs/ART_COVERAGE.md`

When adding goods:

- add exact art for every player-visible trade good
- keep category and generic entries only as temporary fallbacks for newly added goods
- rerun coverage and confirm `Trade goods exact art` remains 100%

When adding upgrade slots:

- add a slot fallback in `UPGRADE_ART`
- generate a slot image

When changing ship name roots:

- assign each root to a `SHIP_FAMILY_TERMS` family
- add a new ship family only when the silhouette should visibly differ

## Validation Checklist

Run these before commit:

```bash
npm run art:coverage -- --write
npm run lint
npm run build
npm test
git diff --check
```
