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
TOKEN=$(curl -s -X POST http://localhost:4001/v1/credentials \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"dev consumer"}' | jq -r .token)

# Apply a one-entry schedule (replace audio_url with a reachable MP3)
curl -s -X PUT http://localhost:4003/v1/radio/schedule \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"entries":[{"audio_url":"https://example.com/sample.mp3","title":"test"}]}'
```

## Endpoints

| Service           | URL                                            | Notes                                |
| ----------------- | ---------------------------------------------- | ------------------------------------ |
| HLS playlist      | http://localhost:8080/hls/master.m3u8          | 3-bitrate ladder                     |
| Icecast status    | http://localhost:8000                          | Source mount: `funk.mp3`             |
| Liquidsoap telnet | localhost:1234                                 | `echo help \| nc 127.0.0.1 1234`     |
| Live harbor       | localhost:8001                                 | Mount: `live`                        |
| Breaking harbor   | localhost:8002                                 | Mount: `breaking`                    |
| Radio API         | http://localhost:4003                          | Hono / Bun                           |
| Auth API          | http://localhost:4001                          | Hono / Bun                           |
| Storage API       | http://localhost:4002                          | Hono / Bun                           |
| MinIO console     | http://localhost:9001                          | From `control.dev.env` creds         |
| Postgres (host)   | localhost:5432                                 | Only exposed in dev override         |

## Health check

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'funk-(control|media)'
curl -s -o /dev/null -w "hls:     %{http_code}\n" http://localhost:8080/hls/master.m3u8
curl -s -o /dev/null -w "auth:    %{http_code}\n" http://localhost:4001/health
curl -s -o /dev/null -w "storage: %{http_code}\n" http://localhost:4002/health
curl -s -o /dev/null -w "radio:   %{http_code}\n" http://localhost:4003/health
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

- **MinIO presigned download URLs** point at whatever `S3_PUBLIC_ENDPOINT` resolves to. Keep it set to a host the browser can reach (default `http://localhost:9000` in dev).
- **Radio reaches auth via the shared `funk_dev` bridge** (see "One-time setup" above). The host-gateway approach used previously broke on hosts whose firewall blocks bridge-to-host traffic; the shared external network is more portable.
- **Liquidsoap harbor passwords** in `media.dev.env` must match what hosts use when connecting their broadcasting tools. Defaults are `devlive_change_me` and `devbreaking_change_me`.
- **HLS CORS headers** live in `infra/services/media-nginx/nginx.conf`. Each regex location declares its own `add_header` block — nginx does not inherit. Editing the file requires `docker restart funk-media-nginx-1`; `nginx -s reload` does not pick up the change reliably.
- **`demo/svelte-poc/`** is a legacy POC of the old invitation-token auth flow and will not work against the credential-issuer auth in this repo. Consumer-side code is intended to live in a separate repo per [ADR-003](adr/ADR-003-funk-consumer-boundary.md); the demo dir is kept only as a historical artifact for now.
