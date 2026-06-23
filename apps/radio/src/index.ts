import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
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
  applied_at: string | null;
  entries: ScheduleEntry[];
}

// Escape a value for use inside a liquidsoap annotate: key="value" pair.
// Backslash first (so we don't double-escape the quotes we add), then quote.
// Without this an odd/hostile title could break the playlist line or inject
// extra annotations (e.g. a title containing `",funk_source="live`).
function escapeAnnotation(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Inverse of escapeAnnotation: collapse the liquidsoap annotate: escaping
// (\" -> ", \\ -> \) when parsing the m3u back into entries.
function unescapeAnnotation(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

// Parse a single `title="..."` value out of an annotate: annotation list,
// honoring backslash-escaped quotes so we stop at the real closing quote.
function extractAnnotationTitle(annotations: string): string | undefined {
  const m = annotations.match(/title="((?:\\.|[^"\\])*)"/);
  return m ? unescapeAnnotation(m[1] ?? "") : undefined;
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

// Reverse writePlaylist(): the m3u file on the volume is the source of truth for
// the schedule (it is what liquidsoap actually reads), so GET parses it back
// instead of relying on volatile in-memory state that a restart would drop.
// applied_at is the file's mtime; a missing file means "no schedule applied yet".
async function readPlaylist(): Promise<ScheduleWindow> {
  let raw: string;
  let mtime: Date;
  try {
    raw = await readFile(env.SCHEDULE_FILE, "utf8");
    mtime = (await stat(env.SCHEDULE_FILE)).mtime;
  } catch {
    return { applied_at: null, entries: [] };
  }

  const entries: ScheduleEntry[] = [];
  // Per writePlaylist, each entry is an optional `#EXTINF:<dur>,<title>` line
  // followed by an `annotate:funk_source="schedule"[,title="..."]:<audio_url>`
  // line. Carry the #EXTINF over to the next playlist line.
  let pendingTitle: string | undefined;
  let pendingDuration: number | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#EXTINF:")) {
      // #EXTINF:<dur>,<title>  — dur === -1 means "unknown" -> undefined.
      const rest = trimmed.slice("#EXTINF:".length);
      const comma = rest.indexOf(",");
      const durStr = comma === -1 ? rest : rest.slice(0, comma);
      const dur = Number.parseInt(durStr, 10);
      pendingDuration = Number.isNaN(dur) || dur < 0 ? undefined : dur;
      pendingTitle = comma === -1 ? undefined : rest.slice(comma + 1) || undefined;
      continue;
    }
    if (trimmed.startsWith("#")) continue; // #EXTM3U or other comments

    // Playlist line. Strip the annotate: prefix to recover the audio_url, and
    // prefer the annotation title (it survives even without an #EXTINF line).
    let audioUrl = trimmed;
    let annotationTitle: string | undefined;
    if (trimmed.startsWith("annotate:")) {
      const body = trimmed.slice("annotate:".length);
      // annotate:<annotations>:<uri> — the annotations are quoted key=val pairs,
      // so the first colon that is OUTSIDE a quoted string separates uri from
      // annotations. Walk the string tracking quote/escape state.
      let inQuote = false;
      let escaped = false;
      let splitAt = -1;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ":" && !inQuote) { splitAt = i; break; }
      }
      if (splitAt !== -1) {
        annotationTitle = extractAnnotationTitle(body.slice(0, splitAt));
        audioUrl = body.slice(splitAt + 1);
      }
    }

    entries.push({
      audio_url: audioUrl,
      title: annotationTitle ?? pendingTitle,
      duration_seconds: pendingDuration,
    });
    pendingTitle = undefined;
    pendingDuration = undefined;
  }

  return { applied_at: mtime.toISOString(), entries };
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
  for (const s of store.listSessionsByMount(mount)) {
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
  return c.json({
    applied: true,
    entries: entries.length,
    applied_at: new Date().toISOString(),
  });
});

app.get("/v1/radio/schedule", async (c) => {
  // Source of truth is the m3u file on the volume (what liquidsoap reads), so
  // the schedule survives a radio restart — no in-memory cache to drop.
  return c.json(await readPlaylist());
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
