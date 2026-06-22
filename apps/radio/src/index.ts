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
// Persistence is out of scope for v0.1 — an in-memory Map is fine.

interface LiveCredentialRecord {
  id: string;
  label: string;
  mount: "live" | "breaking";
  username: string;
  password_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const liveCredentials = new Map<string, LiveCredentialRecord>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, rec] of liveCredentials) {
    if (new Date(rec.expires_at).getTime() < now) liveCredentials.delete(id);
  }
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
  liveCredentials.set(id, rec);
  return { record: rec, plainPassword: plain };
}

// --- Session store ----------------------------------------------------------
//
// Tracks active and recent harbor sessions for attribution lookups. Sessions
// older than 7 days after disconnect are GC'd.
//
// Keyed by credential_id. activeSessions tracks which credential_id is
// currently live on a given mount — used by the disconnect hook (liquidsoap
// on_disconnect has no credential context, so radio resolves it internally).

interface SessionRecord {
  credential_id: string;
  mount: string;
  label: string;
  connected_at: string;
  disconnected_at: string | null;
}

const sessions = new Map<string, SessionRecord>();
// mount → credential_id for the currently-connected source on that mount
const activeSessions = new Map<string, string>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pruneSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.disconnected_at && new Date(s.disconnected_at).getTime() < cutoff) {
      sessions.delete(id);
    }
  }
}

function recordSessionStart(credentialId: string, mount: string, label: string, connectedAt: string): void {
  pruneSessions();
  sessions.set(credentialId, {
    credential_id: credentialId,
    mount,
    label,
    connected_at: connectedAt,
    disconnected_at: null,
  });
  activeSessions.set(mount, credentialId);
}

// Accepts credential_id directly (preferred) or resolves from the active mount.
function recordSessionEnd(credentialIdOrNull: string | null, mount: string | null, disconnectedAt: string): boolean {
  const credentialId = credentialIdOrNull ?? (mount ? activeSessions.get(mount) ?? null : null);
  if (!credentialId) return false;
  const s = sessions.get(credentialId);
  if (!s) return false;
  s.disconnected_at = disconnectedAt;
  if (mount) activeSessions.delete(mount);
  return true;
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

// --- Recordings discovery ---------------------------------------------------

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

// Populated by the recordings daemon via POST /v1/radio/internal/recording-uploaded
// after each successful upload. Keyed by storage_key so retries are idempotent.
const uploadedRecordings = new Map<string, RecordingEntry>();

// Filename shape comes from funk.liq's output.file templates:
//   live-YYYYMMDD-HHMMSS.mp3
//   breaking-YYYYMMDD-HHMMSS.mp3
const RECORDING_FILENAME_RE = /^(live|breaking)-(\d{8})-(\d{6})\.mp3$/;

function parseRecordingFilename(
  filename: string,
): { source: "live" | "breaking"; started_at: string } | null {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const source = m[1] as "live" | "breaking";
  const d = m[2];
  const t = m[3];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  return { source, started_at: iso };
}

// Find the session whose window contains started_at within ±30s tolerance.
function findAttribution(
  mount: string,
  startedAt: string,
): { credential_id: string; label: string } | null {
  const ts = new Date(startedAt).getTime();
  const TOLERANCE_MS = 30 * 1000;
  for (const s of sessions.values()) {
    if (s.mount !== mount) continue;
    const connectedMs = new Date(s.connected_at).getTime();
    const disconnectedMs = s.disconnected_at ? new Date(s.disconnected_at).getTime() : Date.now();
    if (ts >= connectedMs - TOLERANCE_MS && ts <= disconnectedMs + TOLERANCE_MS) {
      return { credential_id: s.credential_id, label: s.label };
    }
  }
  return null;
}

function listRecordings(sinceIso: string | undefined): RecordingEntry[] {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  const results = [...uploadedRecordings.values()].filter(
    (e) => new Date(e.started_at).getTime() >= since,
  );
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
  const cred = [...liveCredentials.values()].find(
    (r) => r.mount === body.mount && r.username === body.username,
  );
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

// Daemon notifies radio after a successful upload. Idempotent on storage_key
// (re-notifications overwrite the entry, which is what we want on retry).
app.post("/v1/radio/internal/recording-uploaded", async (c) => {
  if (!requireInternalSecret(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as {
    mount?: "live" | "breaking";
    started_at?: string;
    storage_key?: string;
    storage_url?: string;
    duration_seconds?: number | null;
    size_bytes?: number | null;
    credential_id?: string | null;
    credential_label?: string | null;
  } | null;
  if (!body?.mount || !body?.started_at || !body?.storage_key || !body?.storage_url) {
    return c.json({ error: "mount, started_at, storage_key, storage_url required" }, 400);
  }
  uploadedRecordings.set(body.storage_key, {
    id: body.storage_key,
    source: body.mount,
    started_at: body.started_at,
    duration_seconds: body.duration_seconds ?? null,
    size_bytes: body.size_bytes ?? null,
    storage_url: body.storage_url,
    storage_key: body.storage_key,
    credential_id: body.credential_id ?? null,
    credential_label: body.credential_label ?? null,
  });
  return c.json({ recorded: true }, 200);
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
    credentials: [...liveCredentials.values()].map((r) => ({
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
  const rec = liveCredentials.get(c.req.param("id"));
  if (!rec) return c.json({ error: "not found" }, 404);
  rec.revoked_at = new Date().toISOString();
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

// recordings (discovery — storage_url populated by daemon after upload)

app.get("/v1/radio/recordings", (c) => {
  const since = c.req.query("since") ?? undefined;
  return c.json({ recordings: listRecordings(since) });
});

const port = env.PORT;
console.log(`funk-radio listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
