# FUNK

**FUNK** is open-source backend infrastructure for movement platforms: radio, learning commons, and collective knowledge tools. Built tenant-first so consumer platforms can self-host or run as a tenant of a shared FUNK instance.

> Status: pre-alpha. v0 scaffold. APIs will change.

## Direction (decided 2026-05-26)

Three architecture decisions define FUNK's current shape — read them before contributing:

- **[ADR-001](docs/adr/ADR-001-machine-facing-funk.md)** — FUNK is machine-facing. Consumers own all human identity; FUNK only issues service credentials.
- **[ADR-002](docs/adr/ADR-002-liquidsoap-radio-api.md)** — The media plane runs liquidsoap directly behind a thin HTTPS control API. LibreTime is being removed.
- **[ADR-003](docs/adr/ADR-003-funk-consumer-boundary.md)** — Build domain features in the consumer first; harvest into FUNK only when a second consumer needs the same thing.

If you're building a consumer, start with [`docs/CONSUMER_BRIEF.md`](docs/CONSUMER_BRIEF.md).

## What FUNK gives a tenant

- **Service credentials** — long-lived bearer tokens, one per consumer platform. Anonymous-listen by default at the HLS origin; FUNK has no concept of human users (see [ADR-001](docs/adr/ADR-001-machine-facing-funk.md)).
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

> Full runbook with endpoints, health checks, teardown, and gotchas: [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)


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

### Real broadcasting

For real shows, a consumer pushes a schedule to FUNK's radio API and hosts stream live via icecast. See [ADR-002](docs/adr/ADR-002-liquidsoap-radio-api.md) for the API surface and [`docs/CONSUMER_BRIEF.md`](docs/CONSUMER_BRIEF.md) for the integration model.

> The previously-documented LibreTime opt-in stack is being removed per [ADR-002](docs/adr/ADR-002-liquidsoap-radio-api.md). The legacy scripts (`scripts/libretime-setup.sh`, `scripts/libretime-up.sh`) and `compose.media.libretime.yml` represent the prior approach and will be deleted.

## License

[AGPL-3.0](./LICENSE) — hosted forks must share source. If you'd like a commercial exception for a specific use case, open an issue.
