import { Hono } from "hono";
import chokidar from "chokidar";
import { stat, readdir, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Filename pattern — matches what liquidsoap writes.
// Directory layout: RECORDINGS_DIR/{live,breaking}/<mount>-YYYYMMDD-HHMMSS.mp3
// ---------------------------------------------------------------------------

const RECORDING_FILENAME_RE = /^(live|breaking)-(\d{8})-(\d{6})\.mp3$/;

interface ParsedFilename {
  mount: "live" | "breaking";
  started_at: string; // ISO 8601 UTC
}

function parseFilename(filename: string): ParsedFilename | null {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const mount = m[1] as "live" | "breaking";
  const d = m[2];
  const t = m[3];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  return { mount, started_at: iso };
}

// ---------------------------------------------------------------------------
// Storage key construction per contract in docs/v0.1-attributed-live-sessions.md
// ---------------------------------------------------------------------------

function safeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function buildStorageKey(
  mount: string,
  datePart: string, // YYYYMMDD
  timePart: string, // HHMMSS
  attribution: Attribution | null,
): string {
  const base = `${mount}-${datePart}-${timePart}`;
  if (!attribution) {
    return `recordings/${mount}/${base}-unattributed.mp3`;
  }
  const label = safeLabel(attribution.label);
  const shortId = attribution.credential_id.replace(/-/g, "").slice(0, 8);
  return `recordings/${mount}/${base}-${label}-${shortId}.mp3`;
}

// ---------------------------------------------------------------------------
// Daemon credential — minted once at startup via ADMIN_BOOTSTRAP_TOKEN.
// Retries with exponential backoff; never crashes.
// ---------------------------------------------------------------------------

let daemonToken: string | null = null;

async function mintDaemonCredential(): Promise<string> {
  const res = await fetch(`${env.AUTH_URL}/v1/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ADMIN_BOOTSTRAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "recordings-daemon" }),
  });
  if (!res.ok) throw new Error(`auth mint failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function ensureDaemonCredential(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      daemonToken = await mintDaemonCredential();
      console.log("daemon credential minted");
      return;
    } catch (err) {
      const wait = Math.min(60 * 2 ** attempt, 3600);
      console.warn(`credential mint failed (attempt ${attempt}): ${err}; retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Attribution lookup
// ---------------------------------------------------------------------------

interface Attribution {
  credential_id: string;
  label: string;
}

async function lookupAttribution(
  mount: string,
  started_at: string,
): Promise<Attribution | null> {
  const url = `${env.RADIO_URL}/v1/radio/internal/recording-attribution?mount=${encodeURIComponent(mount)}&started_at=${encodeURIComponent(started_at)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.RADIO_INTERNAL_SECRET}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      // 5xx or unexpected — treat as unattributed, log a warning.
      console.warn(`attribution lookup non-2xx (${res.status}) for ${mount}/${started_at}; treating as unattributed`);
      return null;
    }
    return (await res.json()) as Attribution;
  } catch (err) {
    // Connection refused (Track A not yet deployed) or network error — treat as unattributed.
    // TODO: once Track A merges, this path should only fire for genuine network failures.
    // The radio side will need to ensure GET /v1/radio/recordings populates storage_url
    // by reading the .meta.json sidecar this daemon writes (see writeMetaSidecar below).
    console.warn(`attribution lookup failed for ${mount}/${started_at}: ${err}; treating as unattributed`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Duration via ffprobe (installed in Dockerfile)
// ---------------------------------------------------------------------------

async function getDurationSeconds(filepath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filepath,
    ]);
    const d = parseFloat(stdout.trim());
    return isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upload to FUNK storage
// ---------------------------------------------------------------------------

async function uploadRecording(
  filepath: string,
  storageKey: string,
  meta: { mount: string; started_at: string; duration_seconds: number | null; credential_id?: string; label?: string },
): Promise<string> {
  if (!daemonToken) throw new Error("daemon token not ready");

  const form = new FormData();
  form.append("file", Bun.file(filepath), storageKey);

  const res = await fetch(`${env.STORAGE_URL}/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`storage upload failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  // Return the storage URL that consumers can use to fetch the file.
  return `${env.STORAGE_URL}/files/${data.key}`;
}

// ---------------------------------------------------------------------------
// Pending-file queue with per-file retry state
// ---------------------------------------------------------------------------

interface PendingFile {
  filepath: string;
  mount: "live" | "breaking";
  started_at: string;
  datePart: string;
  timePart: string;
  attempt: number;
  nextRetry: number; // epoch ms
}

const pending = new Map<string, PendingFile>();
// Files currently being processed (to avoid duplicate concurrent uploads).
const inFlight = new Set<string>();

function scheduleRetry(entry: PendingFile): void {
  entry.attempt += 1;
  const waitSec = Math.min(60 * 2 ** (entry.attempt - 1), 3600);
  entry.nextRetry = Date.now() + waitSec * 1000;
  console.log(`retry ${entry.attempt} for ${entry.filepath} in ${waitSec}s`);
}

async function processFile(entry: PendingFile): Promise<void> {
  if (inFlight.has(entry.filepath)) return;
  inFlight.add(entry.filepath);
  try {
    const attribution = await lookupAttribution(entry.mount, entry.started_at);
    const m = basename(entry.filepath).match(RECORDING_FILENAME_RE);
    if (!m || !m[2] || !m[3]) throw new Error("unexpected: filename re-parse failed");
    const storageKey = buildStorageKey(entry.mount, m[2], m[3], attribution);

    const duration = await getDurationSeconds(entry.filepath);
    const meta = {
      mount: entry.mount,
      started_at: entry.started_at,
      duration_seconds: duration,
      ...(attribution ? { credential_id: attribution.credential_id, label: attribution.label } : {}),
    };

    const storageUrl = await uploadRecording(entry.filepath, storageKey, meta);
    console.log(`uploaded ${entry.filepath} → ${storageUrl}`);

    // Delete the local file after a confirmed upload.
    await unlink(entry.filepath).catch((e) => console.warn(`unlink failed: ${e}`));

    pending.delete(entry.filepath);
  } catch (err) {
    console.error(`upload failed for ${entry.filepath}: ${err}`);
    scheduleRetry(entry);
  } finally {
    inFlight.delete(entry.filepath);
  }
}

// ---------------------------------------------------------------------------
// Stable-file detection: a file is ready when its mtime hasn't changed for
// STABILITY_SECONDS. chokidar's awaitWriteFinish handles this for new events;
// we re-check the pending queue for retries on a tick.
// ---------------------------------------------------------------------------

function enqueue(filepath: string): void {
  if (pending.has(filepath) || inFlight.has(filepath)) return;

  const filename = basename(filepath);
  const parsed = parseFilename(filename);
  if (!parsed) return; // not a recording file shape; ignore

  const m = filename.match(RECORDING_FILENAME_RE)!;
  const entry: PendingFile = {
    filepath,
    mount: parsed.mount,
    started_at: parsed.started_at,
    datePart: m[2]!,
    timePart: m[3]!,
    attempt: 0,
    nextRetry: Date.now(),
  };
  pending.set(filepath, entry);
}

// Drain the queue: process any entry whose nextRetry time has passed.
async function drainQueue(): Promise<void> {
  const now = Date.now();
  for (const entry of pending.values()) {
    if (entry.nextRetry <= now) {
      // Fire-and-forget; processFile manages inFlight.
      processFile(entry).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Startup scan: pick up any stable files that survived a daemon restart.
// "Stable" here means mtime older than STABILITY_SECONDS.
// ---------------------------------------------------------------------------

async function startupScan(): Promise<void> {
  const cutoff = Date.now() - env.STABILITY_SECONDS * 1000;
  for (const subdir of ["live", "breaking"] as const) {
    const dir = join(env.RECORDINGS_DIR, subdir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of files) {
      if (!RECORDING_FILENAME_RE.test(filename)) continue;
      const filepath = join(dir, filename);
      const st = await stat(filepath).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs <= cutoff) {
        console.log(`startup scan: queuing stable file ${filepath}`);
        enqueue(filepath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FS watcher
// ---------------------------------------------------------------------------

function startWatcher(): void {
  const watchDirs = ["live", "breaking"].map((d) => join(env.RECORDINGS_DIR, d));
  const watcher = chokidar.watch(watchDirs, {
    persistent: true,
    ignoreInitial: true, // startup scan handles existing files
    awaitWriteFinish: {
      stabilityThreshold: env.STABILITY_SECONDS * 1000,
      pollInterval: 1000,
    },
  });

  watcher.on("add", (filepath) => {
    console.log(`new stable file detected: ${filepath}`);
    enqueue(filepath);
  });

  watcher.on("error", (err) => {
    console.error(`watcher error: ${err}`);
  });
}

// ---------------------------------------------------------------------------
// Retry tick — runs every 10s, drains entries whose backoff has elapsed.
// ---------------------------------------------------------------------------

function startRetryTick(): void {
  setInterval(() => {
    drainQueue().catch((e) => console.error(`drainQueue error: ${e}`));
  }, 10_000);
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

const app = new Hono();

app.get("/health", async (c) => {
  let free_bytes: number | null = null;
  try {
    const { stdout } = await execFileAsync("df", ["-B1", "--output=avail", env.RECORDINGS_DIR]);
    const lines = stdout.trim().split("\n");
    const val = lines[1] ? parseInt(lines[1].trim(), 10) : NaN;
    if (isFinite(val)) free_bytes = val;
  } catch {
    // df not available in all envs; not fatal
  }
  return c.json({ status: "ok", pending: pending.size, free_bytes });
});

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

console.log(`funk-recordings starting (recordings_dir=${env.RECORDINGS_DIR}, stability=${env.STABILITY_SECONDS}s)`);

// Mint credential first (blocking with retries), then scan + watch.
ensureDaemonCredential().then(async () => {
  await startupScan();
  // Drain anything the startup scan found immediately.
  await drainQueue();
  startWatcher();
  startRetryTick();
}).catch((err) => {
  console.error("fatal: credential bootstrap failed:", err);
  process.exit(1);
});

const port = env.PORT;
console.log(`funk-recordings listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};
