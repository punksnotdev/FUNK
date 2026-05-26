# FUNK Architecture (v0)

> **Direction (2026-05-26):** Current decisions live in [`adr/`](adr/). In short:
>
> - FUNK is **machine-facing only**; consumers own human identity ([ADR-001](adr/ADR-001-machine-facing-funk.md)).
> - The media plane runs **liquidsoap directly** behind a thin HTTPS control API; the LibreTime stack documented below is being phased out ([ADR-002](adr/ADR-002-liquidsoap-radio-api.md)).
> - Domain features build in the consumer first; harvest into FUNK on rule-of-three ([ADR-003](adr/ADR-003-funk-consumer-boundary.md)).
>
> Diagram below describes the **target** shape; some sections (LibreTime opt-in stack, invitation-token auth) reflect the legacy implementation and will be revised as code catches up.

## Two-plane model

FUNK splits a tenant's deployment into two independent Docker Compose stacks:

- **Control plane** (`compose.control.yml`): Postgres, MinIO, FUNK auth service, FUNK storage API, optional CMS, optional Caddy reverse proxy.
- **Media plane** (`compose.media.yml`): Icecast, FFmpeg HLS generator, Nginx HLS origin, optional Caddy reverse proxy. LibreTime stack (`compose.media.libretime.yml`) is opt-in and broadcasts into the same Icecast.

The planes have separate internal networks and can live on separate machines. The control plane talks to the media plane only over public endpoints (Icecast source URL, HLS origin URL).

```
┌──────────────────────── CONTROL PLANE ────────────────────────┐
│                                                                │
│  postgres ◄── auth ◄── storage ──► minio                       │
│                  ▲                                             │
│                  └──── caddy (optional) ◄── public HTTPS       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                            │
                            │ scheduling / metadata (HTTPS)
                            ▼
┌───────────────────────── MEDIA PLANE ─────────────────────────┐
│                                                                │
│  ┌─ LibreTime (opt-in) ─────┐                                  │
│  │ postgres + rabbitmq +    │                                  │
│  │ api + legacy + nginx +   │                                  │
│  │ analyzer + worker +      │                                  │
│  │ playout + liquidsoap ────┼──► icecast (FUNK)                │
│  └──────────────────────────┘            │                     │
│                                          ▼                     │
│                                  hls (FFmpeg)                  │
│                                          │                     │
│                                          ▼                     │
│                                  nginx HLS origin              │
│                                          ▲                     │
│                                          └── caddy ──► CDN     │
│                                                                │
└────────────────────────────────────────────────────────────────┘

The icecast `funk.mp3` mount is the integration boundary: anything that
can publish a mountpoint there (LibreTime liquidsoap, an external DJ
tool, the pink-noise test source, a manual ffmpeg) becomes the broadcast
content. FUNK's HLS pipeline doesn't care who's on the other side.
```

## Why this split

- **Failure isolation**: media outages don't take down auth/storage and vice versa.
- **Scaling shape**: HLS origin scales horizontally; control plane is mostly stateful.
- **Resource profile**: media plane is CPU+bandwidth heavy; control plane is RAM+IO.
- **Sovereignty**: a tenant can self-host the control plane and use a managed media plane (or vice versa) without architectural changes.

## Tenancy in v0

v0 is single-tenant per deployment. "Multi-tenancy" in FUNK means *each tenant runs their own FUNK*, not *one FUNK serves many tenants*. The hosted-multi-tenant model is deferred until after the self-host MVP.

The auth service has a `TENANT_ID` env that defaults to `default`. All sessions and tokens are scoped to it. This makes the eventual multi-tenant rewrite a database migration, not an API rewrite.

## Anti-surveillance defaults

- No user-agent logging in nginx
- No persistent client IDs
- No third-party analytics
- HLS origin emits CORS but no tracking headers
- Auth sessions are opaque tokens, no JWT claims about the user
