# FUNK Architecture (v0)

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
