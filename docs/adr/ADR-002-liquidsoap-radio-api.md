# ADR-002: FUNK media plane = liquidsoap + thin HTTPS control API

## Status

Accepted — 2026-05-26

## Context

The current opt-in LibreTime stack (`compose.media.libretime.yml`) brings ~8 services (api, legacy PHP, nginx, analyzer, worker, playout, liquidsoap, postgres, rabbitmq) wrapped around the actual audio engine. It's operationally heavy, legacy Python+PHP, and outdated. Two facts collapse the case for keeping it:

1. **The consumer will own all admin UX** (see ADR-003). FUNK doesn't need to ship a radio admin UI; LibreTime's main contribution becomes redundant.
2. **Liquidsoap is the irreducible audio engine.** Everything LibreTime adds is coordination machinery around liquidsoap — scheduling, library, recording, RBAC — and the consumer already models all of that in its own domain.

Probability of needing to swap LibreTime over 2–3 years was estimated at ~40–50% (it's itself a fork of abandoned Airtime; operational complexity is a constant). But the stronger argument for the change isn't swap probability — it's that the *value* LibreTime adds is exactly the part a consumer will replace.

## Decision

FUNK's media plane runs **liquidsoap directly**, with no LibreTime layer. FUNK exposes a thin HTTPS control API for consumers.

### Audio pipeline

```
liquidsoap → icecast → ffmpeg-hls → nginx (HLS origin) → CDN
```

One audio engine, no scheduler service, no second postgres, no RabbitMQ, no PHP UI.

### Priority chain in liquidsoap

```liq
main      = playlist(reload="manual", "/etc/funk/schedule.m3u")
live      = input.harbor("live",     port=8001, auth=funk_auth_live)
breaking  = input.harbor("breaking", port=8002, auth=funk_auth_break)
interrupt = request.queue(id="interrupt")

out = fallback(track_sensitive=false, [breaking, interrupt, live, main])
output.icecast(out, host="icecast", mount="funk.mp3", ...)

# Record only when live/breaking sources are active:
output.file(%mp3, "/var/funk/recordings/live/$(timestamp).mp3",     live)
output.file(%mp3, "/var/funk/recordings/breaking/$(timestamp).mp3", breaking)
```

Pre-uploaded show files already live in FUNK storage (MinIO), so liquidsoap streams them straight from their storage URLs. Recording is restricted to live/breaking harbor inputs — re-recording pre-uploaded files would be wasteful.

### API surface

Three operational categories with distinct semantics, plus discovery for recordings.

**Schedule (declarative, idempotent)**

```
PUT  /v1/radio/schedule        # body: next-N-hours window (full replace)
GET  /v1/radio/schedule        # currently-applied window
GET  /v1/radio/now-playing     # live telemetry
```

The schedule is *state to converge to*, not a sequence of edits. The consumer computes the next-N-hours window from its own domain layer and PUTs the whole thing on every change. FUNK validates, writes the liquidsoap playlist, signals reload. Idempotent, stateless on the FUNK side.

**Live transmission credentials**

```
POST   /v1/radio/live/credentials       # mint a mount credential for a host
GET    /v1/radio/live/credentials       # list active
DELETE /v1/radio/live/credentials/:id   # revoke
GET    /v1/radio/live/status            # who's connected
```

Bearer passwords on the harbor mount. Hosts connect via standard broadcasting tools (Butt, Mixxx, OBS).

**Interrupts (imperative, one-shot)**

```
POST   /v1/radio/interrupt          # body: { audio_url, ducking? } — play this clip now
DELETE /v1/radio/interrupt          # cancel current interrupt
POST   /v1/radio/interrupt/live     # mint breaking-news live-takeover credential
```

Pre-recorded clip → push URL into liquidsoap's `interrupt` queue. Live takeover → mint a credential for the `breaking` harbor mount.

**Live-session recordings (discovery only)**

```
GET /v1/radio/recordings?since=<ts>
# returns: [{ id, source, credential_id, started_at, ended_at, duration, storage_url }, ...]
```

Recording is automatic for harbor sources. Completed recordings get uploaded to storage with metadata; the consumer polls this endpoint and attaches `storage_url` to its episode records.

### Source-of-truth rule

> **The consumer owns the domain CRUD; FUNK exposes apply + control verbs over the running broadcast.**

No CRUD on shows/episodes in FUNK. Edit/delete/update happen in the consumer, which re-PUTs the schedule window when anything affecting upcoming broadcasts changes.

### Archive playback

Archived episodes (whether pre-uploaded or recorded-from-live) live in FUNK storage. Listeners stream them via HTTP Range requests on storage URLs — `<audio src="https://storage.../episode.mp3">` and the browser handles seek/instant-play natively. **No on-demand HLS transcoding infrastructure.**

## Consequences

**Easier**

- Media plane drops from ~8 services to 4 small containers (liquidsoap + icecast + ffmpeg-hls + nginx).
- One file to debug audio issues: liquidsoap's `.liq` config.
- Cleaner contract for AI agents: an HTTPS API instead of a legacy PHP admin to scrape.
- Operationally tractable on small Coolify VPSes.

**Harder**

- FUNK now carries a small liquidsoap config layer and a new radio service. Schedule translation, recording-upload daemon, and credential management are FUNK's responsibility.
- No drop-in admin UI for future FUNK consumers who don't want to build their own. Mitigation: any future consumer can opt LibreTime (or any other scheduler) back in against the same icecast mount — the broadcast boundary is unchanged.
- Liquidsoap's `.liq` DSL has a learning curve for operators (manageable; lots of examples online).

**Given up**

- LibreTime's library/show-management UI as a fallback — intentionally; the consumer builds what it needs.
- Continuous recording of all output — intentionally; pre-uploaded files don't need re-recording.

## Implementation notes

- **Remove:** `infra/compose/compose.media.libretime.yml`, `scripts/libretime-setup.sh`, `scripts/libretime-up.sh`, any `infra/env/libretime*.env*`.
- **Add:** `infra/services/liquidsoap/funk.liq` (config template), `apps/radio/` (the thin HTTPS control service in Bun: schedule apply, credential CRUD, interrupt push, recording discovery, recording-upload daemon).
- **Update:** `infra/compose/compose.media.yml` adds `liquidsoap` service, drops the `with-libretime` profile.
- **Docs:** README, `ARCHITECTURE.md`, `LOCAL_DEV.md`, `PROVISIONING.md` — drop LibreTime instructions, document the new shape.
