# FUNK

**FUNK** is open-source backend infrastructure for movement platforms: radio, learning commons, and collective knowledge tools. Built tenant-first so platforms like [uaolaf](https://github.com/uaolaf) can self-host or run as a tenant of a shared FUNK instance.

> Status: pre-alpha. v0 scaffold. APIs will change.

## What FUNK gives a tenant

- **Auth** — invitation tokens, sessions. Anonymous-listen by default; identified contributors via invitation.
- **Storage** — S3-compatible object storage (MinIO) behind a small upload/serve API.
- **Radio** — scheduled audio broadcasts via LibreTime → Icecast → FFmpeg HLS → Nginx origin. CDN-ready, low-bandwidth-friendly.
- **Tenant scaffolding** — control + media docker-compose stacks split across two planes, with `dev` / `staging` / `prod` env templates and a Coolify deployment playbook.

What FUNK explicitly does **not** do:

- Track users or build profiles
- Algorithmic feeds or recommendations
- Mandatory accounts for consumption

## Layout

```
FUNK/
├── apps/
│   ├── auth/              # invitation token + session service (TS, Bun)
│   └── storage/           # MinIO upload/serve API (TS, Bun)
├── packages/
│   └── shared/            # shared types
├── infra/
│   ├── compose/           # compose.control.yml, compose.media.yml
│   ├── env/               # .env.example per plane per environment
│   ├── services/          # media-hls (FFmpeg), media-nginx (origin)
│   └── ops/               # Caddy + Coolify configs
├── demo/
│   └── svelte-poc/        # SvelteKit POC exercising auth + storage + HLS playback
├── docs/
│   ├── ARCHITECTURE.md
│   └── PROVISIONING.md
└── scripts/               # validate, health, deploy helpers
```

## Quickstart (local dev)

```bash
# control plane (auth + storage + postgres + minio)
cp infra/env/control.dev.env.example infra/env/control.dev.env
docker compose --env-file infra/env/control.dev.env \
  -f infra/compose/compose.control.yml \
  -f infra/compose/compose.control.dev.override.yml \
  up -d

# media plane (icecast + hls + nginx) with a pink-noise test source
cp infra/env/media.dev.env.example infra/env/media.dev.env
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  --profile with-test-source \
  up -d

# demo POC
cd demo/svelte-poc && cp -n .env.example .env && bun install && bun run dev
# → http://localhost:5173
```

### Adding real LibreTime (scheduled programming)

Replace the pink-noise test source with the full LibreTime scheduler. It broadcasts into FUNK's existing icecast, so the HLS pipeline is unchanged.

```bash
# 1. Stop the test source (if running)
docker compose --env-file infra/env/media.dev.env \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  rm -sf media-source

# 2. Generate secrets + config, pull images, migrate DB (idempotent)
bash scripts/libretime-setup.sh

# 3. Bring everything up
bash scripts/libretime-up.sh

# LibreTime web UI: http://localhost:8090  (default admin/admin — change immediately)
# Upload audio in the UI; schedule a show; the stream appears at
# http://localhost:8080/hls/master.m3u8
```

## License

[AGPL-3.0](./LICENSE) — hosted forks must share source. If you'd like a commercial exception for a specific use case, open an issue.
