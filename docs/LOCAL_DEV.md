# Local dev runbook

How to lift, check, and tear down the full FUNK stack on a single machine.

All compose commands assume you're at the repo root: `/home/furenku/punksnotdev/proyectos/FUNK/dev/FUNK`.

> **Direction (2026-05-26):** The LibreTime path (`scripts/libretime-setup.sh`, `scripts/libretime-up.sh`) and the invitation-token bootstrap are being phased out per [ADR-001](adr/ADR-001-machine-facing-funk.md) and [ADR-002](adr/ADR-002-liquidsoap-radio-api.md). Target shape: media plane runs `liquidsoap` directly (no LibreTime); pink-noise stays as the dev test source until the `liquidsoap` service lands. Treat the steps below as the current legacy path; consult the ADRs and [`CONSUMER_BRIEF.md`](CONSUMER_BRIEF.md) for the direction.

## Bring it up

### 1. Control plane — postgres, minio, auth, storage

```bash
cp -n infra/env/control.dev.env.example infra/env/control.dev.env   # first time only
docker compose --env-file infra/env/control.dev.env \
  -f infra/compose/compose.control.yml \
  -f infra/compose/compose.control.dev.override.yml \
  up -d
```

### 2. Media plane — icecast + HLS nginx + LibreTime

```bash
cp -n infra/env/media.dev.env.example infra/env/media.dev.env       # first time only
bash scripts/libretime-setup.sh                                     # first time only — generates secrets, materializes config.yml, runs DB migration
bash scripts/libretime-up.sh                                        # wraps the long compose -f -f -f -f up
```

Want pink-noise instead of LibreTime (faster, no scheduling)?

```bash
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  --profile with-test-source up -d
```

### 3. Demo frontend

```bash
cd demo/svelte-poc
bun install        # first time only
bun run dev
```

## Endpoints

| Service          | URL                                            | Notes                                |
| ---------------- | ---------------------------------------------- | ------------------------------------ |
| SvelteKit POC    | http://localhost:5173                          | Auto-bumps to 5174 if 5173 is taken  |
| HLS playlist     | http://localhost:8080/hls/master.m3u8          | 3-bitrate ladder                     |
| Icecast status   | http://localhost:8000                          | Source mount: `funk.mp3`             |
| LibreTime UI     | http://localhost:8090                          | Default creds: `admin` / `admin`     |
| MinIO console    | http://localhost:9001                          | From `control.dev.env` creds         |
| Auth API         | http://localhost:4001                          | Hono / Bun                           |
| Storage API      | http://localhost:4002                          | Hono / Bun                           |
| Postgres (host)  | localhost:5432                                 | Only exposed in dev override         |

## Health check

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep funk
curl -s -o /dev/null -w "hls: %{http_code}\n" http://localhost:8080/hls/master.m3u8
```

You should see 16 containers reporting `healthy` (8 control + 8 media incl. LibreTime).

## Tear down

```bash
# Control plane
docker compose --env-file infra/env/control.dev.env \
  -f infra/compose/compose.control.yml \
  -f infra/compose/compose.control.dev.override.yml \
  down

# Media plane (full chain)
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  -f infra/compose/compose.media.libretime.yml \
  down
```

Add `-v` to either command to wipe volumes (postgres data, MinIO objects, LibreTime media library).

## Gotchas

- **MinIO presigned download URLs** point at whatever `S3_PUBLIC_ENDPOINT` resolves to. Keep it set to a host the browser can reach (default `http://localhost:9000` in dev).
- **LibreTime image tags use full semver** (`4.5.0`, not `4.5`). Pinning to a short tag fails with `manifest unknown`.
- **LibreTime nginx upstreams** are hardcoded as `legacy` / `api`. The compose adds network aliases so renamed services still resolve.
- **HLS CORS headers** live in `infra/services/media-nginx/nginx.conf`. Each regex location declares its own `add_header` block — nginx does not inherit. Editing the file requires `docker restart funk-media-nginx-1`; `nginx -s reload` does not pick up the change reliably.
