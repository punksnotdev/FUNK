# Briefing: a consumer's relationship to FUNK

A self-contained briefing for anyone (human or AI agent) building or extending a **consumer** — a product built on top of **FUNK**.

If you're picking this up cold, read in order: this file → `ARCHITECTURE.md` → the three ADRs in `adr/`.

## What FUNK is

FUNK is open-source backend infrastructure for movement platforms: service credentials, object storage, and radio orchestration. It is **machine-facing only**: no human users, no admin UI, no domain CRUD. Consumers talk to it over HTTPS using a single service credential.

The three decisions that define FUNK's shape:

- **ADR-001** — FUNK is machine-facing; consumers own human identity.
- **ADR-002** — Media plane is liquidsoap + a thin HTTPS control API (no LibreTime).
- **ADR-003** — Boundary discipline: harvest, don't predict.

## What the consumer is

The consumer is **the product**: the application movement participants and contributors actually use. It owns:

- **All human identity** — users, hosts, admins, contributors, sessions, RBAC. Whatever auth stack the consumer brings (a CMS with built-in auth, a third-party identity provider, custom auth).
- **All domain models** — Shows, Episodes, Library items, glossaries, school linkage, community rules. The consumer's editorial schema.
- **All UX** — listener pages, admin screens, calendar views, schedule editors, library browsers.
- **The broadcast schedule.** The consumer is the source of truth for what plays when. It derives the upcoming window from its own domain layer and pushes it to FUNK.

## The contract (the only ways a consumer touches FUNK)

1. **HTTPS APIs** — credentials, storage, radio control.
2. **The icecast mountpoint** — for live broadcasting tools (Butt, Mixxx, OBS).
3. **HLS origin URLs** — for listeners playing the live stream.
4. **Storage URLs** — for listeners streaming archived shows via HTTP Range.

No shared database. No shared filesystem. No code imports. The consumer does not call liquidsoap directly; it goes through FUNK's `/v1/radio/*` endpoints.

## Authentication

The consumer holds one **service credential** issued by FUNK's credential service. Pass it on every FUNK request:

```http
GET https://storage.<tenant>.example/objects/...
Authorization: Bearer <service-credential>
```

The consumer manages its own human-user authentication independently — that's separate from the FUNK credential and never crosses the boundary. FUNK has no concept of human users.

## Storage API

Standard upload/serve over MinIO. Used for:

- Show artwork
- Pre-recorded episode audio
- Library media (PDFs, audio, video, images)
- Any other binary asset

Files live in MinIO; FUNK returns URLs the consumer's pages can embed (with HTTP Range for seek/stream playback in the browser).

**Uploading** — `POST /uploads` (multipart: `file`, optional `storage_key`, optional `metadata` JSON). Two things to know:

- **Always read the `key` from the response — don't assume it equals what you sent.** The server prepends the tenant prefix to any `storage_key` you supply, and if your `storage_key` is malformed (anything outside `[a-zA-Z0-9._/-]`, a leading slash, or a `..` segment) it is **silently replaced with a server-generated random key — no 4xx**. The returned `key` is the canonical handle that `GET /files/<key>` expects.
- The response `id` is a storage DB UUID, **distinct from `key`**. Serve and fetch by `key`, not `id`.

## Radio API

Four operational categories. **All scheduling is declarative apply — no CRUD endpoints.** Edit/delete happens in the consumer's domain layer; whenever the broadcast schedule changes, the consumer recomputes the next-N-hours window and PUTs it.

### Schedule

```
PUT /v1/radio/schedule        # body: next-N-hours window (full replace)
GET /v1/radio/schedule
GET /v1/radio/now-playing
```

A consumer-side hook on episode save/delete recomputes the window and PUTs it. Idempotent.

**Entry shape.** `PUT` body is `{ entries: [...] }`. Each entry:

- `audio_url` (**required**) — the only required field; a storage URL or any liquidsoap-readable URI.
- `title` (optional) — surfaced in `now-playing` for scheduled tracks.
- `duration_seconds` (optional).
- `at` (optional) — accepted, but in v0 it is **not wall-clock-anchored**: the window plays as a sequential playlist, so `at` is advisory metadata, not a scheduled start time.

Fields are `at` / `duration_seconds` — **not** `starts_at` / `ends_at`.

### Now-playing payload

`GET /v1/radio/now-playing` returns `{ source, metadata }`. Switch UI on the
**top-level `source`** — ignore `metadata.source`, which is liquidsoap's raw
internal tag (often `"main"`).

- **Reliably emitted:** `"schedule"` (an annotated playlist track is on air) and
  `"unknown"` (nothing on air / radio couldn't resolve). `"main"` and other raw
  liquidsoap source names appear for un-annotated sources such as the fallback —
  treat the enum as open: `"schedule" | "unknown" | (string & {})`.
- **`source` does NOT reliably report live/breaking.** Harbor sources are live
  inputs, not "requests", so during a host takeover now-playing returns
  `"unknown"` or a stale value. **Drive live/breaking UI from
  `GET /v1/radio/live/status`** (`{ live_connected, breaking_connected }`), not
  from this endpoint.

`metadata` is a free-form, best-effort object:

- **`title`** is guaranteed only for scheduled tracks (FUNK annotates it into the
  playlist). Everything else (`artist`, `genre`, `album`, `song`, liquidsoap
  internals like `status`/`rid`) appears only if the source carries it — **not
  guaranteed**.
- **No artwork/cover URL, no show/program name, and no `credential_label`** are
  ever injected. Pull artwork, program name, and host attribution from your own
  domain data (match on the `liveCredentialId`/label you stamped at mint time).
- **No timing fields** (`started_at` / `elapsed` / `duration_seconds`).
  now-playing is point-in-time — build any progress indicator from your own
  schedule.
- **Empty case:** FUNK returns `metadata: {}` (empty object) when nothing is on
  air or on the error/503 branch.

Example (scheduled track):

```json
{ "source": "schedule",
  "metadata": { "funk_source": "schedule", "title": "Marisol Friday show",
                "song": "Marisol Friday show", "source": "main", "status": "playing" } }
```

Nothing on air: `{ "source": "unknown", "metadata": {} }`. (`artist`/`genre`/etc.
appear only when the file's tags carry them; `metadata.source: "main"` is
liquidsoap's internal tag — read the **top-level** `source`.)

### Live transmission credentials

```
POST   /v1/radio/live/credentials
GET    /v1/radio/live/credentials
DELETE /v1/radio/live/credentials/:id
GET    /v1/radio/live/status
```

Mint a credential when a host is approved to go live for an upcoming show. Hand it to the host. The host's broadcasting tool connects to FUNK's icecast harbor mount with the credential. Revoke after the show.

`POST /v1/radio/live/credentials` (and `POST /v1/radio/interrupt/live` for breaking) returns:

```json
{ "credential_id": "...", "label": "...", "mount": "live",
  "harbor_host": "...", "harbor_port": 8001,
  "username": "...", "password": "...", "expires_at": "..." }
```

- **`password` is returned exactly once.** It is never stored in plaintext and cannot be re-fetched — capture it at mint time.
- **`harbor_host` / `harbor_port` are the media plane's *internal* address** (`liquidsoap` : `8001` live / `8002` breaking). They are **not reachable as-is** from outside the media network. In **local dev**, rewrite to `localhost` and the host-published ports (**`7481` live, `7482` breaking**) before handing them to a broadcasting tool. In **prod**, map them to your public icecast ingress. Don't pass the raw values straight through to a host.

### Interrupts (breaking news)

```
POST   /v1/radio/interrupt        # body: { audio_url, ducking? } — play this clip now
DELETE /v1/radio/interrupt        # cancel/end current interrupt
POST   /v1/radio/interrupt/live   # mint a breaking-news live-takeover credential
```

Pre-recorded clip → POST a storage URL; liquidsoap cuts in within ~1s. Live takeover → mint a breaking-news credential, anchor connects, broadcast switches to them automatically.

### Recordings (discovery)

```
GET /v1/radio/recordings?since=<ts>
```

FUNK automatically records every live and breaking-news session (and only those — pre-uploaded files don't need re-recording). The consumer polls this endpoint after live shows and attaches the resulting `storage_url` to the relevant episode in its own domain layer. Trimming, splitting, republishing the recording is the consumer's editorial concern.

`GET /v1/radio/recordings?since=<ts>` returns `{ recordings: [...] }`, each:

```json
{ "id": "default/recordings/live/live-20260613-110550-marisol-1a2b3c4d.mp3",
  "source": "live", "started_at": "2026-06-13T11:05:50Z",
  "duration_seconds": 1820, "size_bytes": 29216000,
  "storage_url": "https://storage.../files/default/recordings/live/...mp3",
  "storage_key": "default/recordings/live/...mp3",
  "credential_id": "...", "credential_label": "Marisol Friday show" }
```

- **`id` == `storage_key`** — the full tenant-prefixed object key, **not** a UUID. (This is the opposite of the Storage API, where `id` is a DB UUID.) Stream/download via `storage_url`.
- `source` is `"live"` or `"breaking"`; `started_at` (UTC) is derived from the key.
- `credential_id` / `credential_label` carry host attribution when the session matched a known live credential — **either may be `null`** for an unattributed session. Match them against the `label` you stamped at mint time to recover the show/host from your own domain data.
- `duration_seconds` may be `null` if the daemon didn't stamp it; `size_bytes` comes from storage and is normally present.

## What a consumer does NOT do

- Don't call liquidsoap directly. It lives on FUNK's media plane and is not network-exposed.
- Don't store shows/episodes/schedule entries in FUNK's database — FUNK has no such tables.
- Don't ask FUNK to authenticate human users. FUNK has no concept of human users.
- Don't build a second radio admin UI in FUNK. Build it in the consumer.
- Don't expect on-demand HLS for archives. Use the storage URL in an `<audio>` tag; the browser handles Range-based streaming.

## How to decide where something belongs

Apply the litmus test from ADR-003:

> Would a second, unrelated consumer built on FUNK want this — unchanged?

- **Yes** (a capability anyone would want): could go in FUNK eventually, but **build it in the consumer first** and harvest later on rule-of-three.
- **No** (encodes your editorial / ideological / community choices): stays in the consumer forever.

Bias toward:

- API-first surfaces (so agents can drive them) over hand-built admin screens.
- Declarative state-apply over imperative edit/delete sequences.
- Stateless services with one source of truth over shared mutable state.

## Local dev

Bring FUNK up locally (see `LOCAL_DEV.md`), then run the consumer separately. The consumer's environment needs:

- `FUNK_STORAGE_URL`, `FUNK_RADIO_URL` (or a single `FUNK_BASE_URL`)
- `FUNK_SERVICE_TOKEN` — the credential FUNK issued to this consumer
- `ICECAST_LIVE_HOST`, `ICECAST_LIVE_PORT` — for displaying broadcast endpoints to hosts

## Prompt for an AI agent working in a consumer

> You are working in a **consumer** — a product built on top of **FUNK** infrastructure. Read `FUNK/docs/CONSUMER_BRIEF.md` and the three ADRs in `FUNK/docs/adr/` before designing anything that touches FUNK.
>
> Hard boundary: the consumer owns all human identity, domain models, UX, and the broadcast schedule. FUNK owns only service credentials, object storage, and the running broadcast pipeline (liquidsoap → icecast → HLS). You interact with FUNK only via its HTTPS APIs and the icecast mountpoint — no shared DB, filesystem, or imports.
>
> When unsure where a feature belongs, apply the litmus test in ADR-003: would a *second* consumer built on FUNK want this same thing, unchanged? If yes, it can eventually live in FUNK — but build it in the consumer first and harvest later (rule of three). If no, it stays in the consumer forever.
>
> All radio scheduling is declarative apply: edit shows/episodes in the consumer's domain layer, recompute the next-N-hours window, PUT it to FUNK. No CRUD endpoints in FUNK for show data.
