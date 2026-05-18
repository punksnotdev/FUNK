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
cd infra/compose && docker compose --env-file ../env/control.dev.env -f compose.control.yml up -d

# media plane (icecast + libretime + hls + nginx)
cp ../env/media.dev.env.example ../env/media.dev.env
docker compose --env-file ../env/media.dev.env -f compose.media.yml up -d

# demo POC
cd ../../demo/svelte-poc && bun install && bun run dev
```

## License

[AGPL-3.0](./LICENSE) — hosted forks must share source. If you'd like a commercial exception for a specific use case, open an issue.
