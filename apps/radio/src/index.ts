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

// --- Harbor credentials + sessions (control-plane-owned) ---------------------
//
// ADR-004 Amendment (2026-06-23): the media plane is fully stateless. Harbor
// credentials + sessions live in the control-plane `auth` service (Postgres);
// radio holds NO durable credential/session state. radio keeps the public
// POST /v1/radio/live/credentials surface (the consumer contract is unchanged)
// and delegates persistence + validation to auth over HTTP via internal
// endpoints guarded by AUTH_INTERNAL_SECRET (sent as a bearer).
//
// Mint/list/revoke/session/attribution all round-trip to auth; only harbor-auth
// validation is read through a short ephemeral in-memory cache (see below).

const AUTH_INTERNAL_HEADERS = {
  authorization: `Bearer ${env.AUTH_INTERNAL_SECRET}`,
  "content-type": "application/json",
} as const;

function authInternalUrl(path: string): string {
  return `${env.AUTH_URL}${path}`;
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

interface MintedCredential {
  id: string;
  label: string;
  mount: "live" | "breaking";
  username: string;
  expires_at: string;
}

// Mint a harbor credential. radio generates the username + plaintext password;
// auth hashes the password and persists the row. The plaintext is returned to
// the consumer exactly once (it is never stored anywhere durable). Throws on a
// non-2xx response so the caller surfaces a 503.
async function mintCredential(
  mount: "live" | "breaking",
  label: string,
  ttlSeconds: number,
): Promise<{ record: MintedCredential; plainPassword: string }> {
  const plain = randomPassword();
  const username = `${slugify(label)}-${randomUUID().slice(0, 8)}`;
  const res = await fetch(authInternalUrl("/v1/internal/harbor/credentials"), {
    method: "POST",
    headers: AUTH_INTERNAL_HEADERS,
    body: JSON.stringify({ mount, label, username, password: plain, ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`auth mint failed: ${res.status}`);
  const data = (await res.json()) as {
    credential_id: string;
    label: string;
    mount: string;
    username: string;
    expires_at: string;
  };
  // Minting bypasses (and invalidates) the validate cache — a new credential
  // must be immediately usable, never masked by a stale negative cache entry.
  invalidateValidateCache(mount, username);
  return {
    record: {
      id: data.credential_id,
      label: data.label,
      mount: data.mount as "live" | "breaking",
      username: data.username,
      expires_at: data.expires_at,
    },
    plainPassword: plain,
  };
}

interface ListedCredential {
  id: string;
  label: string;
  mount: "live" | "breaking";
  username: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

async function listCredentials(): Promise<ListedCredential[]> {
  const res = await fetch(authInternalUrl("/v1/internal/harbor/credentials"), {
    headers: AUTH_INTERNAL_HEADERS,
  });
  if (!res.ok) throw new Error(`auth list failed: ${res.status}`);
  const data = (await res.json()) as { credentials: ListedCredential[] };
  return data.credentials;
}

// Returns true if the credential existed (whether or not it was already revoked).
async function revokeCredential(id: string): Promise<boolean> {
  const res = await fetch(authInternalUrl(`/v1/internal/harbor/credentials/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: AUTH_INTERNAL_HEADERS,
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`auth revoke failed: ${res.status}`);
  // Drop the whole validate cache: we don't know the (mount, username) here, and
  // a revoked credential must stop validating promptly. Bounded by cache size.
  validateCache.clear();
  return true;
}

// --- Harbor-auth validation cache -------------------------------------------
//
// Ephemeral, volatile read-through cache (lost on restart — a cache, NOT state)
// so a brief auth blip doesn't immediately break harbor connections. Keyed by
// mount+username; caches the full validate result (positive or negative) for a
// short TTL. Revocation latency is bounded by the TTL: a revoke clears the cache
// immediately (revokeCredential above), and a revoke that happens elsewhere
// still takes effect within VALIDATE_CACHE_TTL_MS. Keep the TTL short.

const VALIDATE_CACHE_TTL_MS = 60 * 1000;

interface ValidateResult {
  valid: boolean;
  credential_id?: string;
  label?: string;
}

interface CacheEntry {
  // The password the cached result applies to. A different password for the same
  // (mount, username) must NOT be served a stale positive/negative.
  password: string;
  result: ValidateResult;
  expiresAt: number;
}

const validateCache = new Map<string, CacheEntry>();

function cacheKey(mount: string, username: string): string {
  return `${mount} ${username}`;
}

function invalidateValidateCache(mount: string, username: string): void {
  validateCache.delete(cacheKey(mount, username));
}

// Validate (mount, username, password) against auth, read-through the cache.
// Cache hits skip the network call entirely; on a cache miss we ask auth. If
// auth is unreachable, fall back to a still-fresh-enough cache entry so a brief
// control-plane blip doesn't drop an in-progress reconnect (the accepted
// trade-off in the ADR amendment). Password is part of the cache key check —
// a cached positive only applies to the same password.
async function validateHarbor(
  mount: string,
  username: string,
  password: string,
): Promise<ValidateResult> {
  const key = cacheKey(mount, username);
  const cached = validateCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now && cached.password === password) {
    return cached.result;
  }

  try {
    const res = await fetch(authInternalUrl("/v1/internal/harbor/validate"), {
      method: "POST",
      headers: AUTH_INTERNAL_HEADERS,
      body: JSON.stringify({ mount, username, password }),
    });
    if (!res.ok) throw new Error(`auth validate failed: ${res.status}`);
    const result = (await res.json()) as ValidateResult;
    validateCache.set(key, { password, result, expiresAt: now + VALIDATE_CACHE_TTL_MS });
    return result;
  } catch (err) {
    // Auth blip: serve a still-fresh cached entry for the same password if we
    // have one; otherwise fail closed (valid: false).
    if (cached && cached.expiresAt > now && cached.password === password) {
      return cached.result;
    }
    return { valid: false };
  }
}

// --- Sessions (control-plane-owned) -----------------------------------------
//
// Session start/end + attribution all round-trip to auth. radio holds no
// session state. The "currently live on a given mount" resolution (formerly the
// activeSessions Map) is done in auth from sessions where disconnected_at IS
// NULL — used by the disconnect hook (liquidsoap on_disconnect has no
// credential context). Failures are swallowed: bookkeeping must never block the
// harbor connect/disconnect path.

async function recordSessionStart(credentialId: string, mount: string, label: string, connectedAt: string): Promise<void> {
  const res = await fetch(authInternalUrl("/v1/internal/harbor/sessions/start"), {
    method: "POST",
    headers: AUTH_INTERNAL_HEADERS,
    body: JSON.stringify({ credential_id: credentialId, mount, label, connected_at: connectedAt }),
  });
  if (!res.ok) throw new Error(`auth session start failed: ${res.status}`);
}

// Accepts credential_id directly (preferred) or lets auth resolve from the mount.
async function recordSessionEnd(credentialIdOrNull: string | null, mount: string | null, disconnectedAt: string): Promise<void> {
  await fetch(authInternalUrl("/v1/internal/harbor/sessions/end"), {
    method: "POST",
    headers: AUTH_INTERNAL_HEADERS,
    body: JSON.stringify({
      credential_id: credentialIdOrNull ?? undefined,
      mount: mount ?? undefined,
      disconnected_at: disconnectedAt,
    }),
  });
}

// Attribution lookup by (mount, started_at ±window), resolved in auth.
async function findAttribution(
  mount: string,
  startedAt: string,
): Promise<{ credential_id: string; label: string } | null> {
  const url = new URL(authInternalUrl("/v1/internal/harbor/attribution"));
  url.searchParams.set("mount", mount);
  url.searchParams.set("started_at", startedAt);
  const res = await fetch(url, { headers: AUTH_INTERNAL_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`auth attribution failed: ${res.status}`);
  return (await res.json()) as { credential_id: string; label: string };
}

interface ActiveSession {
  credential_id: string;
  mount: string;
  label: string;
  connected_at: string;
}

// Which credential is currently connected per mount, from auth's active harbor
// sessions. Used to enrich live/status with the real on-air host identity.
async function listActiveSessions(): Promise<ActiveSession[]> {
  const res = await fetch(authInternalUrl("/v1/internal/harbor/active"), {
    headers: AUTH_INTERNAL_HEADERS,
  });
  if (!res.ok) throw new Error(`auth active sessions failed: ${res.status}`);
  const body = (await res.json()) as { sessions?: ActiveSession[] };
  return body.sessions ?? [];
}

// --- Schedule ---------------------------------------------------------------

interface ScheduleEntry {
  at?: string;
  audio_url: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
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

// Parse a single `<key>="..."` value out of an annotate: annotation list,
// honoring backslash-escaped quotes so we stop at the real closing quote. `key`
// is always a fixed literal (title/artist/album/year/genre), so inlining it
// into the pattern is safe.
function extractAnnotation(annotations: string, key: string): string | undefined {
  const m = annotations.match(new RegExp(key + '="((?:\\\\.|[^"\\\\])*)"'));
  return m ? unescapeAnnotation(m[1] ?? "") : undefined;
}

async function writePlaylist(entries: ScheduleEntry[]): Promise<void> {
  await mkdir(dirname(env.SCHEDULE_FILE), { recursive: true });
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    if (e.title) lines.push(`#EXTINF:${e.duration_seconds ?? -1},${e.title}`);
    // Attach per-track metadata via liquidsoap's annotate: protocol so the
    // scheduled tags surface in now-playing. The m3u #EXTINF title alone is
    // NOT propagated into the playing source's runtime metadata; annotations
    // are. funk_source marks these as schedule-driven so now-playing can report
    // a meaningful source instead of "unknown".
    const annotations = [`funk_source="schedule"`];
    if (e.title) annotations.push(`title="${escapeAnnotation(e.title)}"`);
    if (e.artist) annotations.push(`artist="${escapeAnnotation(e.artist)}"`);
    if (e.album) annotations.push(`album="${escapeAnnotation(e.album)}"`);
    if (e.year !== undefined) annotations.push(`year="${e.year}"`);
    if (e.genre) annotations.push(`genre="${escapeAnnotation(e.genre)}"`);
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
    let annotationArtist: string | undefined;
    let annotationAlbum: string | undefined;
    let annotationYear: string | undefined;
    let annotationGenre: string | undefined;
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
        const ann = body.slice(0, splitAt);
        annotationTitle = extractAnnotation(ann, "title");
        annotationArtist = extractAnnotation(ann, "artist");
        annotationAlbum = extractAnnotation(ann, "album");
        annotationYear = extractAnnotation(ann, "year");
        annotationGenre = extractAnnotation(ann, "genre");
        audioUrl = body.slice(splitAt + 1);
      }
    }

    const year = annotationYear !== undefined ? Number(annotationYear) : undefined;
    entries.push({
      audio_url: audioUrl,
      title: annotationTitle ?? pendingTitle,
      ...(annotationArtist ? { artist: annotationArtist } : {}),
      ...(annotationAlbum ? { album: annotationAlbum } : {}),
      ...(year !== undefined && Number.isFinite(year) ? { year } : {}),
      ...(annotationGenre ? { genre: annotationGenre } : {}),
      duration_seconds: pendingDuration,
    });
    pendingTitle = undefined;
    pendingDuration = undefined;
  }

  return { applied_at: mtime.toISOString(), entries };
}

// --- Recording attribution lookup -------------------------------------------
//
// Used by the daemon at upload time (GET /v1/radio/internal/recording-attribution)
// to find which host's session was on-air when a recording started, so the
// attribution can be baked into the storage key. This is the live-session
// window match — resolved in the control-plane auth service (see findAttribution
// above); radio holds no session state.

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
// The storage listing returns the FULL stored key, which is tenant-prefixed
// (e.g. `default/recordings/...`). We tolerate any leading path prefix before
// the `recordings/` segment. short_cred_id is the first 8 chars of the
// credential UUID (hyphens stripped), hence exactly 8 hex chars. safe_label is
// [a-z0-9-], so the trailing `-<8 hex>` is the attribution tail; everything
// before it (after the timestamp) is the label. `unattributed` has no tail.
const RECORDING_KEY_RE =
  /(?:^|\/)recordings\/(live|breaking)\/(live|breaking)-(\d{8})-(\d{6})-(.+)\.mp3$/;

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
//
// ADR-004 Amendment: credentials now live in the control-plane auth service, so
// this lists them over HTTP (the auth-backed listCredentials) rather than a
// local sqlite store — hence async. An auth blip falls back to the key's data.
async function resolveKeyAttribution(parsed: ParsedKey): Promise<{
  credential_id: string | null;
  credential_label: string | null;
}> {
  if (!parsed.short_cred_id) return { credential_id: null, credential_label: null };
  let creds: ListedCredential[] = [];
  try {
    creds = await listCredentials();
  } catch {
    creds = []; // auth unreachable — fall through to the key's own data below
  }
  for (const cred of creds) {
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

    const attribution = await resolveKeyAttribution(parsed);
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

  // Validate against the control plane (auth/postgres), read through a short
  // ephemeral cache so a brief auth blip doesn't immediately break harbor auth.
  const result = await validateHarbor(body.mount, body.username, body.password);
  if (!result.valid || !result.credential_id) return c.json({ valid: false }, 200);

  // Record the session start. Best-effort: a bookkeeping failure must not reject
  // a valid harbor connection (attribution would just be missing for it).
  await recordSessionStart(
    result.credential_id,
    body.mount,
    result.label ?? "",
    body.connected_at,
  ).catch(() => {});
  return c.json({ valid: true, credential_id: result.credential_id, label: result.label }, 200);
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
  await recordSessionEnd(
    body.credential_id ?? null,
    body.mount ?? null,
    body.disconnected_at,
  ).catch(() => {});
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
  const attribution = await findAttribution(mount, startedAt).catch(() => null);
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
      artist: typeof r.artist === "string" ? r.artist : undefined,
      album: typeof r.album === "string" ? r.album : undefined,
      year: typeof r.year === "number" ? r.year : undefined,
      genre: typeof r.genre === "string" ? r.genre : undefined,
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
  try {
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
  } catch (err) {
    return c.json({ error: "credential issuer unavailable" }, 503);
  }
});

app.get("/v1/radio/live/credentials", async (c) => {
  try {
    const credentials = await listCredentials();
    return c.json({
      credentials: credentials.map((r) => ({
        id: r.id,
        label: r.label,
        mount: r.mount,
        username: r.username,
        created_at: r.created_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
      })),
    });
  } catch (err) {
    return c.json({ error: "credential issuer unavailable" }, 503);
  }
});

app.delete("/v1/radio/live/credentials/:id", async (c) => {
  try {
    const ok = await revokeCredential(c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: "credential issuer unavailable" }, 503);
  }
});

app.get("/v1/radio/live/status", async (c) => {
  try {
    const status = await getHarborStatus();
    // Enrich connectivity with the real on-air host identity per mount, sourced
    // from auth's active harbor session (NOT a schedule guess). Best-effort: an
    // auth blip falls back to connectivity booleans with null identity.
    let sessions: ActiveSession[] = [];
    try {
      sessions = await listActiveSessions();
    } catch {
      // auth unreachable — keep the booleans, omit identity.
    }
    const credentialFor = (mount: string) => {
      const s = sessions.find((x) => x.mount === mount);
      return s
        ? { credential_id: s.credential_id, label: s.label, connected_at: s.connected_at }
        : null;
    };
    return c.json({
      ...status,
      live_credential: status.live_connected ? credentialFor("live") : null,
      breaking_credential: status.breaking_connected ? credentialFor("breaking") : null,
    });
  } catch (err) {
    return c.json(
      {
        live_connected: false,
        breaking_connected: false,
        live_credential: null,
        breaking_credential: null,
        error: String(err),
      },
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
  try {
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
  } catch (err) {
    return c.json({ error: "credential issuer unavailable" }, 503);
  }
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
