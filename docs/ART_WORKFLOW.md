# Art Workflow

This project uses subtle background art on focused/detail surfaces and a small set of primary fleet cards. The info card remains the reference pattern: upper-card art, dark lower content, and readable text overlays.

## Source Of Truth

Runtime art selection lives in `src/ui/art.ts`.

- Ships resolve by generated ship name root into a ship family, then to an image.
- Stations resolve by archetype, generated name-root subtype, and scale, then fall back to the broad archetype.
- Goods resolve by exact good id first, then category fallback.
- Upgrade goods resolve by upgrade slot.
- Contract row art derives from existing goods, ships, or destination stations.
- Syndicate company art derives from the syndicate's lead ship until dedicated company art exists.
- Header backdrops resolve by semantic section key, such as market bazaar, shipyard upgrades, or stock tape.

The coverage report uses the same resolver, so update `src/ui/art.ts` before generating or judging missing art.

Placement notes live in `docs/ART_PLACEMENT_REPORT.md`.

## Asset Layout

Project-bound images live under `public/art/`.

- `public/art/ships/` for ship family images.
- `public/art/stations/` for station archetype, subtype, and scale images.
- `public/art/goods/` for exact goods and category fallback images.
- `public/art/upgrades/` for upgrade slot fallback images.
- `public/art/headers/` for section and table header backdrops.

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
2. Generate the image with the built-in image tool using existing assets as the style target.
3. Copy or convert the chosen output into `public/art/...`.
4. Use WebP, roughly quality `82`, unless a different format is needed.
5. Run `npm run art:coverage -- --write`.
6. Open `docs/ART_COVERAGE.md` and confirm the missing section is empty or intentionally documented.
7. Run validation before committing.

## Ship Art Generation API

The dev / production server exposes a multi-provider image-gen
endpoint for ship art at `/api/ship-art/generate`. The body shape:

```json
{
  "class": "freighter | courier | hauler | cruiser | exotic",
  "family": "(optional, defaults to class) freighter | courier | hauler | cruiser | exotic | scout | tanker",
  "name": "(optional) ship name to inform proportions",
  "traits": ["self-piloted", "ai-navigator", ...],
  "flavor": "(optional) blueprint flavor string",
  "size": "1024x1024 | 1024x1536 | 1536x1024",
  "quality": "low | medium | high",
  "provider": "openai | gemini"
}
```

The server builds a class-tuned prompt from `server/ship-art.ts`'s
`CLASS_PROMPTS` / `FAMILY_FALLBACK_PROMPTS` / `TRAIT_PROMPTS` blocks.
Each successful generation persists to `.logics-cache/ship-art/`
keyed by provider + class + family + traits hash; subsequent calls
with the same key can either reuse the cached entry or generate a
fresh one.

### Providers

- `gemini` (default) — Google `gemini-2.5-flash-image` via the
  Generative Language `:generateContent` endpoint. Requires
  `GEMINI_API_KEY` (falls back to `GOOGLE_API_KEY`). ~2× faster than
  the OpenAI path at comparable fidelity. The model picks its own
  pixel dimensions (1024-square is typical); aspect hints have to
  ride in the prompt. Override the model with `SHIP_ART_GEMINI_MODEL`
  — setting it to anything starting with `imagen-` (e.g.
  `imagen-4.0-fast-generate-001`, `imagen-4.0-ultra-generate-001`)
  switches the dispatcher to the Imagen `:predict` shape with
  aspect-ratio mapping (`1024x1024 → 1:1`, `1024x1536 → 9:16`,
  `1536x1024 → 16:9`).
- `openai` — `gpt-image-1.5`, takes our pixel sizes directly.
  Requires `OPENAI_API_KEY`. Override the model with
  `SHIP_ART_OPENAI_MODEL`.

Switch the global default with `SHIP_ART_PROVIDER=openai` (or
`gemini`); per-request `provider` always wins.

`GET /api/ship-art/options` returns the allowed enums + the active
default provider.
`GET /api/ship-art/cache` lists every persisted entry.
`GET /api/ship-art/image/:id` streams the bytes.
`GET /api/ship-art/status/:id` returns the generation status.

## Stub Aliases

`docs/ART_COVERAGE.md` includes a "Stub Aliases" section listing
categories whose URL is shared with a category from a different
archetype (e.g. `station:shipyard` reusing `mining-foundry.webp`).
Intra-archetype aliasing — `agri:large` reusing `agricultural-ring.webp`
because every agri scale paints the same plate — is intentional and
not flagged. When a stub alias appears, that category needs its own
dedicated asset; treat the row as a TODO until it does.

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
- header backdrops resolve to existing art

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
