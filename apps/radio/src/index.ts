import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { env } from "./env";
import {
  reloadMainPlaylist,
  pushInterruptUrl,
  cancelInterrupt as soapCancelInterrupt,
  getNowPlayingMetadata,
  getHarborStatus,
} from "./liquidsoap";
import * as store from "./store";
import type { LiveCredentialRecord } from "./store";

interface ResolvedCredential {
  id: string;
  tenant_id: string;
  label: string;
}

async function resolveCredential(authHeader: string | undefined): Promise<ResolvedCredential | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.AUTH_URL}/v1/credentials/me`, {
    headers: { authorization: authHeader },
  });
  if (!res.ok) return null;
  return (await res.json()) as ResolvedCredential;
}

function requireInternalSecret(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  return authHeader.slice("Bearer ".length) === env.RADIO_INTERNAL_SECRET;
}

// --- Credential store -------------------------------------------------------
//
// Per-host live transmission credentials. Each call to
// POST /v1/radio/live/credentials mints a unique username + password, hashed
// at rest. Liquidsoap calls harbor-auth to validate on every connection.
//
// Backed by a durable bun:sqlite store (see ./store and ADR-004 Slice 1) so
// minted credentials survive a radio restart — the in-memory Map was the bug.
// The public + internal contracts are unchanged; only the backing store moved.

function pruneExpired(): void {
  store.pruneExpiredCredentials();
}

// username = slugified label trimmed to 32 chars, guaranteed lowercase alphanum + hyphen
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "host";
}

// random 32-byte URL-safe base64 password (no padding, no + or /)
function randomPassword(): string {
  return randomBytes(32).toString("base64url");
}

async function mintCredential(
  mount: "live" | "breaking",
  label: string,
  ttlSeconds: number,
): Promise<{ record: LiveCredentialRecord; plainPassword: string }> {
  pruneExpired();
  const now = new Date();
  const plain = randomPassword();
  const hash = await Bun.password.hash(plain, "bcrypt");
  const id = randomUUID();
  const rec: LiveCredentialRecord = {
    id,
    label,
    mount,
    username: `${slugify(label)}-${id.slice(0, 8)}`,
    password_hash: hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    revoked_at: null,
  };
  store.insertCredential(rec);
  return { record: rec, plainPassword: plain };
}

// --- Session store ----------------------------------------------------------
//
// Tracks active and recent harbor sessions for attribution lookups. Sessions
// older than 7 days after disconnect are GC'd.
//
// Backed by the same durable bun:sqlite store as credentials (see ./store and
// ADR-004 Slice 1) so in-progress and recent sessions survive a radio restart.
// Keyed by credential_id. The "currently live on a given mount" lookup
// (formerly the activeSessions Map) is derived from sessions where
// disconnected_at IS NULL — used by the disconnect hook (liquidsoap
// on_disconnect has no credential context, so radio resolves it internally).

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pruneSessions(): void {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  store.pruneOldSessions(cutoff);
}

function recordSessionStart(credentialId: string, mount: string, label: string, connectedAt: string): void {
  pruneSessions();
  store.upsertSession({
    credential_id: credentialId,
    mount,
    label,
    connected_at: connectedAt,
    disconnected_at: null,
  });
}

// Accepts credential_id directly (preferred) or resolves from the active mount.
function recordSessionEnd(credentialIdOrNull: string | null, mount: string | null, disconnectedAt: string): boolean {
  const credentialId =
    credentialIdOrNull ?? (mount ? store.getActiveCredentialForMount(mount) : null);
  if (!credentialId) return false;
  return store.endSession(credentialId, disconnectedAt);
}

// --- Schedule ---------------------------------------------------------------

interface ScheduleEntry {
  at?: string;
  audio_url: string;
  title?: string;
  duration_seconds?: number;
}

interface ScheduleWindow {
  applied_at: string;
  entries: ScheduleEntry[];
}

let appliedSchedule: ScheduleWindow | null = null;

// Escape a value for use inside a liquidsoap annotate: key="value" pair.
// Backslash first (so we don't double-escape the quotes we add), then quote.
// Without this an odd/hostile title could break the playlist line or inject
// extra annotations (e.g. a title containing `",funk_source="live`).
function escapeAnnotation(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function writePlaylist(entries: ScheduleEntry[]): Promise<void> {
  await mkdir(dirname(env.SCHEDULE_FILE), { recursive: true });
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    if (e.title) lines.push(`#EXTINF:${e.duration_seconds ?? -1},${e.title}`);
    // Attach per-track metadata via liquidsoap's annotate: protocol so the
    // scheduled title surfaces in now-playing. The m3u #EXTINF title alone is
    // NOT propagated into the playing source's runtime metadata; annotations
    // are. funk_source marks these as schedule-driven so now-playing can report
    // a meaningful source instead of "unknown".
    const annotations = [`funk_source="schedule"`];
    if (e.title) annotations.push(`title="${escapeAnnotation(e.title)}"`);
    lines.push(`annotate:${annotations.join(",")}:${e.audio_url}`);
  }
  await writeFile(env.SCHEDULE_FILE, lines.join("\n") + "\n", "utf8");
}

// --- Recording attribution lookup -------------------------------------------
//
// Used by the daemon at upload time (GET /v1/radio/internal/recording-attribution)
// to find which host's session was on-air when a recording started, so the
// attribution can be baked into the storage key. This is the live-session
// window match — distinct from the recordings *index* below (which is now
// derived from storage, not held in memory).
function findAttribution(
  mount: string,
  startedAt: string,
): { credential_id: string; label: string } | null {
  const ts = new Date(startedAt).getTime();
  const TOLERANCE_MS = 30 * 1000;
  for (const s of store.listSessionsByMount(mount)) {
    const connectedMs = new Date(s.connected_at).getTime();
    const disconnectedMs = s.disconnected_at ? new Date(s.disconnected_at).getTime() : Date.now();
    if (ts >= connectedMs - TOLERANCE_MS && ts <= disconnectedMs + TOLERANCE_MS) {
      return { credential_id: s.credential_id, label: s.label };
    }
  }
  return null;
}

// --- Recordings discovery ---------------------------------------------------
//
// ADR-004 Slice 3: storage is the source of truth. There is NO in-memory index.
// GET /v1/radio/recordings is answered by listing the control-plane storage
// `recordings/` prefix and parsing each key (which already encodes attribution,
// per the v0.1 contract). size_bytes comes from the listing; duration_seconds /
// started_at come from object metadata stamped by the recordings daemon at
// upload time (started_at also re-derivable from the key). The index can't drift
// because there is no index — the objects ARE the truth. Plane isolation holds:
// radio calls storage over HTTP, never MinIO/postgres directly.

interface RecordingEntry {
  id: string;
  source: "live" | "breaking";
  started_at: string;
  duration_seconds: number | null;
  size_bytes: number | null;
  storage_url: string;
  storage_key: string;
  credential_id: string | null;
  credential_label: string | null;
}

// Storage key shape (per docs/v0.1-attributed-live-sessions.md):
//   recordings/<mount>/<mount>-<YYYYMMDD>-<HHMMSS>-<safe_label>-<short_cred_id>.mp3
//   recordings/<mount>/<mount>-<YYYYMMDD>-<HHMMSS>-unattributed.mp3
// short_cred_id is the first 8 chars of the credential UUID (hyphens stripped),
// hence exactly 8 hex chars. safe_label is [a-z0-9-], so the trailing
// `-<8 hex>` is the attribution tail; everything before it (after the timestamp)
// is the label. `unattributed` has no tail.
const RECORDING_KEY_RE =
  /^recordings\/(live|breaking)\/(live|breaking)-(\d{8})-(\d{6})-(.+)\.mp3$/;

interface ParsedKey {
  source: "live" | "breaking";
  started_at: string;
  safe_label: string | null; // null when unattributed
  short_cred_id: string | null; // 8 hex chars, or null when unattributed
}

function parseRecordingKey(key: string): ParsedKey | null {
  const m = key.match(RECORDING_KEY_RE);
  if (!m || !m[1] || !m[3] || !m[4] || !m[5]) return null;
  const source = m[1] as "live" | "breaking";
  const d = m[3];
  const t = m[4];
  const tail = m[5]; // either "unattributed" or "<safe_label>-<short_cred_id>"
  const started_at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;

  if (tail === "unattributed") {
    return { source, started_at, safe_label: null, short_cred_id: null };
  }
  // Split off the trailing `-<8 hex>` attribution id; the rest is the label.
  const credMatch = tail.match(/^(.*)-([0-9a-f]{8})$/);
  if (credMatch && credMatch[1]) {
    return { source, started_at, safe_label: credMatch[1], short_cred_id: credMatch[2]! };
  }
  // Doesn't match the attributed tail shape (e.g. a label with no cred id);
  // expose what we have as the label, no cred id.
  return { source, started_at, safe_label: tail, short_cred_id: null };
}

// Best-effort attribution from the key's 8-char short id. The short id is only 8
// hex chars, so we match it against live credentials to recover the full id and
// the human label. If no live credential matches (e.g. expired-and-pruned, or a
// different radio instance minted it), we still expose what the key carries: the
// short id (un-padded) and the de-slugged safe_label.
function resolveKeyAttribution(parsed: ParsedKey): {
  credential_id: string | null;
  credential_label: string | null;
} {
  if (!parsed.short_cred_id) return { credential_id: null, credential_label: null };
  for (const cred of store.listCredentials()) {
    if (cred.id.replace(/-/g, "").slice(0, 8) === parsed.short_cred_id) {
      return { credential_id: cred.id, credential_label: cred.label };
    }
  }
  // No live match — surface the key's own data so the consumer isn't left blank.
  return {
    credential_id: parsed.short_cred_id,
    credential_label: parsed.safe_label,
  };
}

// --- Storage service token --------------------------------------------------
//
// The storage listing endpoint is authed (any valid FUNK credential). Radio
// mints its own service credential once at startup via ADMIN_BOOTSTRAP_TOKEN —
// the same bootstrap the recordings daemon uses. Minting is retried in the
// background; until it succeeds, GET /recordings returns an empty list rather
// than failing the route.

let storageToken: string | null = null;

async function mintStorageToken(): Promise<string> {
  const res = await fetch(`${env.AUTH_URL}/v1/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ADMIN_BOOTSTRAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "radio-recordings-reader" }),
  });
  if (!res.ok) throw new Error(`auth mint failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function ensureStorageToken(): Promise<void> {
  if (storageToken) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      storageToken = await mintStorageToken();
      console.log("storage service token minted");
      return;
    } catch (err) {
      const wait = Math.min(2 ** attempt, 30);
      console.warn(`storage token mint failed (attempt ${attempt}): ${err}; retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

interface StorageObject {
  key: string;
  size_bytes: number;
  metadata?: Record<string, string>;
}

async function listStorageRecordings(): Promise<StorageObject[]> {
  if (!storageToken) {
    // First call(s) before the token is ready: trigger a mint, return empty.
    ensureStorageToken().catch(() => {});
    return [];
  }
  const url = `${env.STORAGE_URL}/files?prefix=recordings/&metadata=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${storageToken}` } });
  if (res.status === 401) {
    // Token expired/revoked — drop it and re-mint on the next call.
    storageToken = null;
    ensureStorageToken().catch(() => {});
    return [];
  }
  if (!res.ok) {
    throw new Error(`storage list failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { objects?: StorageObject[] };
  return data.objects ?? [];
}

async function listRecordings(sinceIso: string | undefined): Promise<RecordingEntry[]> {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  const objects = await listStorageRecordings();
  const results: RecordingEntry[] = [];
  for (const obj of objects) {
    const parsed = parseRecordingKey(obj.key);
    if (!parsed) continue; // unexpected key shape under recordings/; skip
    if (new Date(parsed.started_at).getTime() < since) continue;

    const attribution = resolveKeyAttribution(parsed);
    // Prefer metadata-stamped values when present; fall back to the key.
    // Keys are hyphenated to match what storage stores (S3 lowercases + the
    // daemon sends `started-at`/`duration-seconds`). S3 returns metadata keys
    // lowercased; we read both shapes defensively.
    const md = obj.metadata ?? {};
    const metaStartedAt = md["started-at"] ?? md["started_at"];
    const started_at = metaStartedAt && !Number.isNaN(Date.parse(metaStartedAt))
      ? metaStartedAt
      : parsed.started_at;
    const metaDuration = md["duration-seconds"] ?? md["duration_seconds"];
    const duration_seconds = metaDuration != null && metaDuration !== ""
      ? Number(metaDuration)
      : null;

    results.push({
      id: obj.key,
      source: parsed.source,
      started_at,
      duration_seconds: Number.isFinite(duration_seconds as number) ? duration_seconds : null,
      size_bytes: obj.size_bytes ?? null,
      storage_url: `${env.STORAGE_PUBLIC_URL}/files/${obj.key}`,
      storage_key: obj.key,
      credential_id: attribution.credential_id,
      credential_label: attribution.credential_label,
    });
  }
  results.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return results;
}

// --- App --------------------------------------------------------------------

const app = new Hono();
app.use("*", cors({ origin: "*", credentials: false }));

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "radio", tenant: env.TENANT_ID });
});

// Internal endpoints — bearer-verified, not exposed publicly.
// These are called by liquidsoap (on the media_private bridge) and the
// recordings daemon. They bypass the FUNK auth service intentionally.

app.post("/v1/radio/internal/harbor-auth", async (c) => {
  if (!requireInternalSecret(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as {
    mount?: string;
    username?: string;
    password?: string;
    source_ip?: string;
    connected_at?: string;
  } | null;
  if (!body?.mount || !body?.username || !body?.password || !body?.connected_at) {
    return c.json({ valid: false }, 200);
  }

  pruneExpired();
  const cred = store.getCredentialByMountUsername(body.mount, body.username);
  if (!cred) return c.json({ valid: false }, 200);
  if (cred.revoked_at) return c.json({ valid: false }, 200);
  if (new Date(cred.expires_at).getTime() < Date.now()) return c.json({ valid: false }, 200);

  const ok = await Bun.password.verify(body.password, cred.password_hash);
  if (!ok) return c.json({ valid: false }, 200);

  recordSessionStart(cred.id, cred.mount, cred.label, body.connected_at);
  return c.json({ valid: true, credential_id: cred.id, label: cred.label }, 200);
});

app.post("/v1/radio/internal/harbor-disconnect", async (c) => {
  if (!requireInternalSecret(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as {
    mount?: string;
    credential_id?: string;
    disconnected_at?: string;
  } | null;
  if (!body?.disconnected_at || (!body?.credential_id && !body?.mount)) {
    return c.json({ error: "disconnected_at and (credential_id or mount) required" }, 400);
  }
  recordSessionEnd(
    body.credential_id ?? null,
    body.mount ?? null,
    body.disconnected_at,
  );
  return c.json({ ok: true }, 200);
});

app.get("/v1/radio/internal/recording-attribution", async (c) => {
  if (!requireInternalSecret(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const mount = c.req.query("mount");
  const startedAt = c.req.query("started_at");
  if (!mount || !startedAt) {
    return c.json({ error: "mount and started_at required" }, 400);
  }
  const attribution = findAttribution(mount, startedAt);
  if (!attribution) return c.json({ error: "not found" }, 404);
  return c.json({ credential_id: attribution.credential_id, label: attribution.label }, 200);
});

// ADR-004 Slice 3: the recordings index is now derived from storage (the objects
// ARE the truth), so radio no longer keeps an in-memory copy. This endpoint is
// retained as a no-op shim so the recordings daemon's post-upload notification
// keeps getting a 2xx during the transition (the daemon treats a non-2xx as a
// stale-index warning). It records nothing — GET /v1/radio/recordings reads the
// storage listing instead.
app.post("/v1/radio/internal/recording-uploaded", async (c) => {
  if (!requireInternalSecret(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ recorded: true, note: "no-op: recordings index derived from storage" }, 200);
});

// All other /v1/* routes require a valid FUNK service credential.

app.use("/v1/*", async (c, next) => {
  const credential = await resolveCredential(c.req.header("authorization"));
  if (!credential) return c.json({ error: "unauthorized" }, 401);
  await next();
});

// schedule (declarative apply)

app.put("/v1/radio/schedule", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
  if (!body || !Array.isArray(body.entries)) {
    return c.json({ error: "body.entries must be an array" }, 400);
  }
  const entries: ScheduleEntry[] = [];
  for (const raw of body.entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.audio_url !== "string") {
      return c.json({ error: "each entry needs audio_url" }, 400);
    }
    entries.push({
      audio_url: r.audio_url,
      at: typeof r.at === "string" ? r.at : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
      duration_seconds: typeof r.duration_seconds === "number" ? r.duration_seconds : undefined,
    });
  }
  await writePlaylist(entries);
  // liquidsoap's reload_mode="watch" should pick up the new file, but poke it
  // explicitly in case the inotify event was missed.
  await reloadMainPlaylist().catch(() => {});
  appliedSchedule = { applied_at: new Date().toISOString(), entries };
  return c.json({
    applied: true,
    entries: entries.length,
    applied_at: appliedSchedule.applied_at,
  });
});

app.get("/v1/radio/schedule", (c) => {
  return c.json(appliedSchedule ?? { applied_at: null, entries: [] });
});

app.get("/v1/radio/now-playing", async (c) => {
  try {
    const meta = await getNowPlayingMetadata();
    return c.json(meta);
  } catch (err) {
    return c.json({ source: "unknown", metadata: {}, error: String(err) }, 503);
  }
});

// live transmission credentials

app.post("/v1/radio/live/credentials", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.length > 0 ? body.label : "unlabeled";
  const ttl = typeof body.ttl_seconds === "number" && body.ttl_seconds > 0 ? body.ttl_seconds : 6 * 3600;
  const { record: rec, plainPassword } = await mintCredential("live", label, ttl);
  return c.json({
    credential_id: rec.id,
    label: rec.label,
    mount: rec.mount,
    harbor_host: env.LIQUIDSOAP_HOST,
    harbor_port: 8001,
    username: rec.username,
    password: plainPassword,
    expires_at: rec.expires_at,
  });
});

app.get("/v1/radio/live/credentials", (c) => {
  pruneExpired();
  return c.json({
    credentials: store.listCredentials().map((r) => ({
      id: r.id,
      label: r.label,
      mount: r.mount,
      username: r.username,
      created_at: r.created_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
    })),
  });
});

app.delete("/v1/radio/live/credentials/:id", (c) => {
  const ok = store.revokeCredential(c.req.param("id"), new Date().toISOString());
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});

app.get("/v1/radio/live/status", async (c) => {
  try {
    const status = await getHarborStatus();
    return c.json(status);
  } catch (err) {
    return c.json(
      { live_connected: false, breaking_connected: false, error: String(err) },
      503,
    );
  }
});

// interrupts (imperative, one-shot)

app.post("/v1/radio/interrupt", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.audio_url !== "string") return c.json({ error: "audio_url required" }, 400);
  try {
    await pushInterruptUrl(body.audio_url);
    return c.json({ pushed: true });
  } catch (err) {
    return c.json({ pushed: false, error: String(err) }, 503);
  }
});

app.delete("/v1/radio/interrupt", async (c) => {
  try {
    await soapCancelInterrupt();
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

app.post("/v1/radio/interrupt/live", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.length > 0 ? body.label : "breaking";
  const ttl = typeof body.ttl_seconds === "number" && body.ttl_seconds > 0 ? body.ttl_seconds : 30 * 60;
  const { record: rec, plainPassword } = await mintCredential("breaking", label, ttl);
  return c.json({
    credential_id: rec.id,
    label: rec.label,
    mount: rec.mount,
    harbor_host: env.LIQUIDSOAP_HOST,
    harbor_port: 8002,
    username: rec.username,
    password: plainPassword,
    expires_at: rec.expires_at,
  });
});

// recordings (discovery — ADR-004 Slice 3: derived by listing storage's
// `recordings/` prefix; no in-memory index, so this survives a radio restart)

app.get("/v1/radio/recordings", async (c) => {
  const since = c.req.query("since") ?? undefined;
  try {
    return c.json({ recordings: await listRecordings(since) });
  } catch (err) {
    return c.json({ error: "recordings listing failed", detail: String(err) }, 503);
  }
});

// Mint the storage service token in the background at boot so the first
// GET /recordings doesn't pay the mint latency. Non-fatal if it fails here —
// listStorageRecordings retries on demand.
ensureStorageToken().catch((err) => console.warn(`initial storage token mint failed: ${err}`));

const port = env.PORT;
console.log(`funk-radio listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
