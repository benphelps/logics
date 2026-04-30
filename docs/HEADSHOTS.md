# Headshot Generation

Logics has a local OpenAI-backed headshot cache for crew and character portraits. Generated files are cached at the OpenAI source size, currently `1024x1024`, under `.logics-cache/headshots`.

The cache is shared across games, but allocation is tracked by numeric game id. When a game asks for a role it has already received, the same cached portrait is returned. When a new game asks for that role, the API prefers an unused cached portrait. If the ready pool gets low, the server queues a small background refill.

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

Useful options:

- `--count` / `-n`: images to create per role. Default: `1`.
- `--roles`: comma-separated role list.
- `--clothing`: optional clothing guidance applied to every generated headshot.
- `--dry-run`: print the seed plan without calling OpenAI.

## API

All endpoints are served by the Vite dev/preview middleware.

- `GET /api/headshots/options`: returns roles, source sizes, qualities, and prompt version.
- `GET /api/headshots/cache`: returns cached entries. Optional query filter: `role`.
- `GET /api/headshots/image/:id`: serves a cached image file.
- `POST /api/headshots/generate`: generates an uncached preview for the submitted role.
- `POST /api/headshots/:gameId/allocate`: returns a game-stable cached portrait for the role, generating one immediately if no reusable portrait exists.

Example allocation:

```http
POST /api/headshots/1/allocate
Content-Type: application/json
```

```json
{
  "role": "pilot",
  "clothing": "patched flight jacket"
}
```

The `gameId` path segment must be numeric.
