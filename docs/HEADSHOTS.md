# Headshot Generation

Logics has a local OpenAI-backed headshot cache for crew and character portraits. Generated files are cached at the OpenAI source size, currently `1024x1024`, under `.logics-cache/headshots`.

The cache is shared across games, but allocation is tracked by numeric game id.

Role/race/sex/age requests use the shared ready pool. When a game asks for a role/race/sex/age pair it has already received, the same cached portrait is returned. When a new game asks for that pair, the API prefers an unused cached portrait. If the ready pool gets low, the server queues a small background refill.

Requests with `clothing` are bespoke. They still include role, race, sex, and age in the prompt, but they always create a unique pending cache entry, return its id immediately, and generate the image in the background. Bespoke clothing entries are never reused by another allocation.

## Environment

Set `OPENAI_API_KEY` before generating new images.

Optional environment values:

- `HEADSHOT_IMAGE_MODEL`: OpenAI image model. Default: `gpt-image-1.5`.
- `HEADSHOT_IMAGE_FORMAT`: output format for cached files. Default: `webp`.
- `HEADSHOT_CACHE_DIR`: cache directory. Default: `.logics-cache/headshots`.

Generation defaults are fixed in the service:

- quality: `low`
- source size: `1024x1024`

## CLI

Bulk seed cached headshots on demand:

```bash
npm run headshots:seed -- --count 2
```

Seed a narrower set:

```bash
npm run headshots:seed -- 3 --roles pilot,navigator
```

Seed selected role/race/sex/age pairs:

```bash
npm run headshots:seed -- --count 2 --roles pilot --races human,alien --sexes female,male --ages "adult,middle aged"
```

Useful options:

- `--count` / `-n`: images to create per role/race/sex/age pair. Default: `1`.
- `--roles`: comma-separated role list.
- `--races`: comma-separated race list. Default: `human,alien`.
- `--sexes`: comma-separated sex list. Default: `female,male,nonbinary`.
- `--ages`: comma-separated age-band list. Default: `young adult,adult,middle aged,elderly`.
- `--dry-run`: print the seed plan without calling OpenAI.

The CLI only seeds pooled role/race/sex/age portraits. Bespoke `clothing` portraits are created through the allocation API because they are always unique and pending.

## Production

The browser calls `/api/headshots/*`, so production must run the Node server, not a static-only Vite/Caddy server. Build and start it with:

```bash
npm run build
npm start
```

`npm start` serves the built `dist/` files and the headshot API from the same origin. Set `PORT` when the host provides one, and set `OPENAI_API_KEY` for new image generation.

If the deploy host auto-detects Vite and creates a static Caddy server, override the runtime start command to `npm start`; static hosting alone cannot serve `/api/headshots/*`. For persistent generated portraits, mount a writable volume and set `HEADSHOT_CACHE_DIR` to that path. Without a persistent cache, generated images are lost on restart.

## API

All endpoints are served by the Vite dev/preview middleware locally and by the production Node server after `npm start`.

- `GET /api/headshots/options`: returns roles, races, sexes, age bands, source sizes, qualities, and prompt version.
- `GET /api/headshots/cache`: returns cached entries. Optional query filters: `role`, `race`, `sex`, `age`.
- `GET /api/headshots/image/:id`: serves a cached image file.
- `GET /api/headshots/status/:id`: returns status for a cached or pending image.
- `POST /api/headshots/generate`: generates an uncached preview for the submitted role.
- `POST /api/headshots/:gameId/allocate`: returns a game-stable cached portrait for the role, generating one immediately if no reusable portrait exists.

Request values are exact strings from `/api/headshots/options`.

Example allocation:

```http
POST /api/headshots/1/allocate
Content-Type: application/json
```

```json
{
  "role": "pilot",
  "race": "human",
  "sex": "female",
  "age": "adult"
}
```

The `gameId` path segment must be numeric.

Bespoke clothing allocation:

```http
POST /api/headshots/1/allocate
Content-Type: application/json
```

```json
{
  "role": "pilot",
  "race": "alien",
  "sex": "female",
  "age": "adult",
  "clothing": "patched flight jacket"
}
```

This returns `202 Accepted` with a pending `entry.id`, `imageUrl`, and `statusUrl`. Poll `GET /api/headshots/status/:id` until the entry is `ready`, then fetch `GET /api/headshots/image/:id`. If `GET /api/headshots/image/:id` is called while pending, it returns `202` with the entry metadata.
