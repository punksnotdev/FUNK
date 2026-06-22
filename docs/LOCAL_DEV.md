# Local dev runbook

How to lift, check, and tear down the full FUNK stack on a single machine.

All compose commands assume you're at the repo root: `/home/furenku/punksnotdev/proyectos/FUNK/dev/FUNK`.

## Bring it up

### 0. One-time setup — shared dev network

The dev overrides attach `auth` and `radio` to a shared external bridge so the
media plane's radio service can resolve auth by DNS name. Create it once:

```bash
docker network create funk_dev
```

(Prod does not use this — the planes live on separate hosts and the radio
service reaches auth via a public HTTPS URL.)

### 1. Control plane — postgres, minio, auth, storage

```bash
cp -n infra/env/control.dev.env.example infra/env/control.dev.env   # first time only
docker compose --env-file infra/env/control.dev.env \
  -f infra/compose/compose.control.yml \
  -f infra/compose/compose.control.dev.override.yml \
  up -d
```

### 2. Media plane — liquidsoap, icecast, HLS, nginx, radio

```bash
cp -n infra/env/media.dev.env.example infra/env/media.dev.env       # first time only
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  up -d
```

When no schedule is applied, liquidsoap broadcasts white-noise fallback so HLS still has segments to serve. PUT a schedule via the radio API (next section) to play real audio.

### 3. Mint a credential and apply a test schedule

```bash
ADMIN_TOKEN=dev_admin_bootstrap_change_me   # matches control.dev.env.example

# Mint a service credential for the consumer
TOKEN=$(curl -s -X POST http://localhost:7401/v1/credentials \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"dev consumer"}' | jq -r .token)

# Apply a one-entry schedule (replace audio_url with a reachable MP3)
curl -s -X PUT http://localhost:7403/v1/radio/schedule \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"entries":[{"audio_url":"https://example.com/sample.mp3","title":"test"}]}'
```

## Endpoints

Host-published dev ports live in the reserved **74xx band** so they never
collide with other local stacks. Container-internal ports are unchanged; the
table below shows the host (left) → internal mapping where they differ. The
ports come from `infra/env/*.dev.env` (`*_HOST_PORT`).

| Service           | URL                                            | Internal | Notes                                |
| ----------------- | ---------------------------------------------- | -------- | ------------------------------------ |
| HLS playlist      | http://localhost:7488/hls/master.m3u8          | 8080     | 3-bitrate ladder                     |
| Icecast status    | http://localhost:7480                          | 8000     | Source mount: `funk.mp3`             |
| Liquidsoap telnet | localhost:7423                                 | 1234     | `echo help \| nc 127.0.0.1 7423`     |
| Live harbor       | localhost:7481                                 | 8001     | Mount: `live`                        |
| Breaking harbor   | localhost:7482                                 | 8002     | Mount: `breaking`                    |
| Radio API         | http://localhost:7403                          | 4003     | Hono / Bun                           |
| Auth API          | http://localhost:7401                          | 4001     | Hono / Bun                           |
| Storage API       | http://localhost:7402                          | 4002     | Hono / Bun                           |
| MinIO API         | http://localhost:7490                          | 9000     | S3 endpoint / presigned URLs         |
| MinIO console     | http://localhost:7491                          | 9001     | From `control.dev.env` creds         |
| Postgres (host)   | localhost:7432                                 | 5432     | Only exposed in dev override         |

## Health check

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'funk-(control|media)'
curl -s -o /dev/null -w "hls:     %{http_code}\n" http://localhost:7488/hls/master.m3u8
curl -s -o /dev/null -w "auth:    %{http_code}\n" http://localhost:7401/health
curl -s -o /dev/null -w "storage: %{http_code}\n" http://localhost:7402/health
curl -s -o /dev/null -w "radio:   %{http_code}\n" http://localhost:7403/health
```

Expect ~9 long-lived containers reporting `healthy`: 4 in control (postgres, minio, auth, storage; `minio-init` runs once and exits) and 5 in media (icecast, liquidsoap, hls, nginx, radio).

## Tear down

```bash
# Control plane
docker compose --env-file infra/env/control.dev.env \
  -f infra/compose/compose.control.yml \
  -f infra/compose/compose.control.dev.override.yml \
  down

# Media plane
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  down
```

Add `-v` to either command to wipe volumes (postgres data, MinIO objects, applied schedule, recordings).

## Gotchas

- **MinIO presigned download URLs** point at whatever `S3_PUBLIC_ENDPOINT` resolves to. Keep it set to a host the browser can reach (default `http://localhost:7490` in dev).
- **Radio reaches auth via the shared `funk_dev` bridge** (see "One-time setup" above). The host-gateway approach used previously broke on hosts whose firewall blocks bridge-to-host traffic; the shared external network is more portable.
- **Per-host harbor credentials** are minted via `POST /v1/radio/live/credentials` (live) or `POST /v1/radio/interrupt/live` (breaking). The response includes `username` and `password` — pass both to your broadcasting tool as the icecast login. Each credential is validated per-connection via an HTTP callback into radio; revocation (`DELETE /v1/radio/live/credentials/:id`) takes effect immediately on the next connection attempt. There is no longer a shared harbor password — `HARBOR_LIVE_PASSWORD` and `HARBOR_BREAKING_PASSWORD` are gone. `RADIO_INTERNAL_SECRET` is the new shared secret used only on the internal `media_private` bridge between liquidsoap and radio.
- **HLS CORS headers** live in `infra/services/media-nginx/nginx.conf`. Each regex location declares its own `add_header` block — nginx does not inherit. Editing the file requires `docker restart funk-media-nginx-1`; `nginx -s reload` does not pick up the change reliably.
- **`demo/svelte-poc/`** is a minimal, working contract-reference demo of the current FUNK contract: a SvelteKit server route holds `FUNK_SERVICE_TOKEN` and proxies `/v1/radio/now-playing`, while the browser plays the anonymous HLS stream directly. Run it with `cd demo/svelte-poc && bun install && bun run dev` (port 7270) after pasting a minted service token into its `.env` — see its `README.md`. Consumer-side code is still meant to live in a separate repo per [ADR-003](adr/ADR-003-funk-consumer-boundary.md); this dir is kept only as a living example of the contract.
