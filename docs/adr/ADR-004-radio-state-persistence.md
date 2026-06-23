# ADR-004: Radio state persistence — stateless media plane, state by source-of-truth

## Status

Accepted — 2026-06-22. **Amended 2026-06-23** (see "Amendment" at the end):
decision §3 is superseded — the media plane goes *fully* stateless; harbor
credentials + sessions move to the control plane, and Slice 1's media-plane
store is removed.

## Context

`apps/radio` keeps four pieces of state in process memory (`apps/radio/src/index.ts`):

| State | What it is |
|---|---|
| `liveCredentials` | minted per-host harbor (broadcast) credentials: username, password hash, mount, TTL, revocation |
| `sessions` / `activeSessions` | harbor session records + currently-on-air-per-mount, used to attribute recordings to the host who made them (7-day window) |
| `uploadedRecordings` | the index backing `GET /v1/radio/recordings` |
| `appliedSchedule` | the last-applied schedule window, backing `GET /v1/radio/schedule` |

All four are lost on any radio restart, crash, OOM, or redeploy. Concrete
failures: a minted-but-unused live credential stops working; an in-progress
host is rejected on reconnect; a finished recording can no longer be attributed
(filed `unattributed` forever); `GET /v1/radio/recordings` goes empty even
though the bytes are safe in MinIO; `GET /v1/radio/schedule` reports empty even
though the m3u on the volume is still driving liquidsoap. v0.1 deliberately
scoped persistence out ("an in-memory Map is fine").

The naive fix — "give radio a database" — raised a fair objection: the **media
plane is supposed to be a stateless, restartable real-time pipeline**
(liquidsoap, icecast, hls, nginx are already stateless processes driven by a
file on a volume). Bolting durable state onto it looks like an antipattern. But
the real antipattern is more specific than "media plane has a database."

## Decision

**The media plane stays stateless for everything whose source of truth lives
elsewhere; it persists durably *only* the state the live broadcast itself needs
in real time.** Each of the four pieces is placed by where its truth naturally
lives, not by convenience.

### 1. Recordings index → derive from control-plane storage (delete the index)

The recording **bytes already live in the control plane** (MinIO, via the
storage service), uploaded under a deterministic key that **already encodes the
attribution** (`recordings/<mount>/<...>-<label>-<short_cred_id>.mp3`, per the
v0.1 contract). An in-memory index in radio is a *redundant copy of control-plane
truth* — the actual antipattern. `GET /v1/radio/recordings` should be answered
by **listing the storage `recordings/` prefix and parsing keys**, with
`size_bytes` from the object listing and `duration_seconds`/`started_at` from
object metadata stamped at upload time. One source of truth (the objects); the
index cannot drift because there is no index.

### 2. Schedule → read the file (no store)

The schedule is **already persisted** as the m3u on the `funk_schedule` volume —
that file is what liquidsoap actually reads. `appliedSchedule` is just a volatile
cache of it. `GET /v1/radio/schedule` should **parse the m3u back**. (FUNK never
echoes `starts_at`/`ends_at` and is explicitly *not* the source of truth for
scheduling — the consumer owns that — so a file round-trip is sufficient.)

### 3. Harbor credentials + sessions → durable, but **media-plane-local**

This is the only genuinely stateful radio-domain data, and it stays on the media
plane **on purpose**: validating a host's harbor connection
(`POST /v1/radio/internal/harbor-auth`) is on the **critical path of going live**.
Coupling that path to control-plane reachability would mean a control-plane
deploy or outage blocks new (and reconnecting) broadcasts — including breaking-news
takeovers. That is a worse antipattern than local state. So the fix here is
about **durability, not location**: replace the in-memory `Map`s with a small
embedded store local to the media plane (`bun:sqlite`, file on a persistent
volume). In-memory was the bug; media-plane-local is correct.

### Cross-plane rule

Where radio does reach the control plane (storage listing for recordings; it
already calls auth/storage), it talks to control-plane **services over HTTPS** —
never directly to the control-plane database. Plane isolation holds: each
service owns its own datastore.

### Summary

| State | Home | Mechanism |
|---|---|---|
| Recordings index | control plane (storage) | derive by listing `recordings/` prefix; no index |
| Schedule | media-plane volume (already) | parse the m3u file on `GET` |
| Harbor credentials | media-plane-local, durable | `bun:sqlite` on a persistent volume |
| Harbor sessions / attribution | media-plane-local, durable | same store |

## Consequences

**Easier**
- Media plane is genuinely stateless except for one small, well-justified local
  store — restarts/redeploys no longer drop credentials, sessions, recordings,
  or schedule.
- The recordings index can't drift from reality (it's derived from the objects).
- Live-broadcast auth survives a control-plane outage.

**Harder**
- `GET /v1/radio/recordings` now depends on a storage listing/metadata capability;
  `duration_seconds` must be stamped as object metadata at upload time (recordings
  daemon change) or recomputed.
- Two persistence mechanisms in play (a sqlite file on the media plane; storage
  objects in the control plane) — but each sits with its natural source of truth.

**Given up**
- The idea of a single radio datastore. Rejected deliberately: it would either
  duplicate control-plane truth (recordings/schedule) or couple the broadcast
  hot path to the control plane (credentials).

## Implementation notes (v0.2)

Ship in slices; keep `tests/e2e/smoke.sh` green after each.

1. **Slice 1 (highest value, self-contained): durable credentials + sessions.**
   Replace `liveCredentials`, `sessions`, `activeSessions` with a `bun:sqlite`
   store (`credentials`, `sessions` tables) on a new persistent volume mounted
   into the radio container. Preserve the exact public API + internal endpoint
   contracts. Re-load on boot; prune expired/old rows on access as today. Verify
   restart-survival: mint a credential, `docker restart funk-media-radio-1`,
   confirm `harbor-auth` still validates it.
2. **Slice 2: schedule from file.** `GET /v1/radio/schedule` parses the m3u
   (and the `annotate:`/`#EXTINF` titles added in the now-playing fix) instead
   of reading `appliedSchedule`.
3. **Slice 3: recordings from storage.** Stamp `duration_seconds`/`started_at`
   as object metadata at upload (recordings daemon); answer
   `GET /v1/radio/recordings` by listing the storage `recordings/` prefix and
   parsing keys; remove `uploadedRecordings` and the
   `POST /v1/radio/internal/recording-uploaded` index callback (or keep it as a
   no-op shim during transition).

## Amendment — 2026-06-23: make the media plane *fully* stateless

This supersedes decision §3. The original ADR kept harbor credentials + sessions
media-plane-local (shipped as Slice 1) to keep the live-broadcast auth path
independent of control-plane availability. We are reversing that call: **the media
plane becomes fully stateless.**

- **Credentials + sessions move to the control plane.** The `auth` service —
  already the credential issuer (ADR-001) — owns harbor credentials in its
  Postgres; sessions/attribution move control-plane-side too. The public
  `POST /v1/radio/live/credentials` (+ `interrupt/live`, `DELETE …/:id`) surface
  **stays on `radio`** so the consumer contract is unchanged; radio delegates
  persistence + validation to the control plane over HTTPS.
- **`radio` keeps only an ephemeral cache.** A short read-through cache (volatile,
  lost on restart — *not* durable state) so a brief control-plane blip doesn't
  immediately break harbor auth. A disposable cache does not violate "stateless."
- **Slice 1's media-plane `bun:sqlite` store + the `funk_radio_state` volume are
  removed.**

**Accepted consequence:** validating a *new* harbor connection now requires the
control plane reachable at connect time (mitigated by the cache for brief blips;
in-flight streams are unaffected). We accept this in exchange for one source of
truth and a genuinely stateless media plane. After this plus Slices 2 & 3, the
media plane holds **zero durable state** — only the schedule `.m3u` (a file
liquidsoap reads) and ephemeral caches.

**New work — Slice 4:** move credentials/sessions to the control plane and strip
the media-plane store. Sequenced **after** Slices 2 & 3 land (they remove the
schedule cache and recordings index; Slice 4 removes the last store), so the
radio refactor builds on a settled base rather than racing two other agents in
the same file.
