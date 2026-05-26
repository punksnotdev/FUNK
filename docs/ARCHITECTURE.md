# FUNK Architecture (v0)

## Two-plane model

FUNK splits a tenant's deployment into two independent Docker Compose stacks:

- **Control plane** (`compose.control.yml`): Postgres, MinIO, FUNK auth (credential issuer), FUNK storage API, optional Caddy reverse proxy.
- **Media plane** (`compose.media.yml`): Liquidsoap audio engine, FUNK radio control API, Icecast, FFmpeg HLS generator, Nginx HLS origin, optional Caddy reverse proxy.

The planes have separate internal networks and can live on separate machines. The radio service on the media plane reaches the control plane's auth service over HTTPS for credential validation — that's the only cross-plane call.

```
┌──────────────────────── CONTROL PLANE ────────────────────────┐
│                                                                │
│  postgres ◄── auth ◄── storage ──► minio                       │
│                  ▲                                             │
│                  └──── caddy (optional) ◄── public HTTPS       │
│                                                                │
└───────────────────────────────┬────────────────────────────────┘
                                │ /v1/credentials/me (HTTPS)
                                ▼
┌───────────────────────── MEDIA PLANE ─────────────────────────┐
│                                                                │
│  consumer ──HTTPS──► radio (FUNK control API)                  │
│                       │ telnet 1234                            │
│                       ▼                                        │
│  hosts ──icecast──► liquidsoap ──► icecast (funk.mp3)          │
│  (harbor 8001/8002)              │                             │
│                                  ▼                             │
│                          hls (FFmpeg)                          │
│                                  │                             │
│                                  ▼                             │
│                          nginx HLS origin                      │
│                                  ▲                             │
│                                  └── caddy ──► CDN             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

The icecast `funk.mp3` mount is the broadcast boundary. Liquidsoap drives it; consumers drive liquidsoap through the radio HTTPS API. Anything else that can publish to that mount (an external DJ tool, a manual ffmpeg) could replace liquidsoap without touching the HLS pipeline downstream.

## Why this split

- **Failure isolation**: media outages don't take down auth/storage and vice versa.
- **Scaling shape**: HLS origin scales horizontally; control plane is mostly stateful.
- **Resource profile**: media plane is CPU + bandwidth heavy; control plane is RAM + IO.
- **Sovereignty**: a tenant can self-host the control plane and use a managed media plane (or vice versa) without architectural changes.

## Tenancy in v0

v0 is single-tenant per deployment. "Multi-tenancy" in FUNK means *each tenant runs their own FUNK*, not *one FUNK serves many tenants*. The hosted-multi-tenant model is deferred until after the self-host MVP.

Every service has a `TENANT_ID` env (defaults to `default`). All credentials, files, and DB rows are scoped to it. This makes the eventual multi-tenant rewrite a database migration, not an API rewrite.

## Anti-surveillance defaults

- No user-agent logging in nginx
- No persistent client IDs
- No third-party analytics
- HLS origin emits CORS but no tracking headers
- Listening is anonymous-open; FUNK never identifies listeners

Human identity (admins, contributors, listeners-with-accounts) lives in the consumer per [ADR-001](adr/ADR-001-machine-facing-funk.md). FUNK enforces the listener-anonymity defaults at the HLS origin, but the consumer is responsible for not building tracking around its own users — that's editorial policy.
