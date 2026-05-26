import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
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

// In-memory live-transmission credentials.
//
// v0 limitation: liquidsoap's input.harbor uses the static HARBOR_*_PASSWORD
// env var, so credentials minted here are *audit/management* entries — the
// actual mount password they hand out is the shared one. To truly invalidate
// a leaked password, rotate the env var and redeploy. Per-host credential
// rotation (auth callback into funk-radio) is a follow-up.

interface LiveCredentialRecord {
  id: string;
  label: string;
  kind: "live" | "breaking";
  harbor_username: string;
  harbor_password: string;
  created_at: string;
  expires_at: string;
}

const liveCredentials = new Map<string, LiveCredentialRecord>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, rec] of liveCredentials) {
    if (new Date(rec.expires_at).getTime() < now) liveCredentials.delete(id);
  }
}

function mintCredential(
  kind: "live" | "breaking",
  label: string,
  ttlSeconds: number,
): LiveCredentialRecord {
  pruneExpired();
  const now = new Date();
  const rec: LiveCredentialRecord = {
    id: randomUUID(),
    label,
    kind,
    harbor_username: kind,
    harbor_password: kind === "live" ? env.HARBOR_LIVE_PASSWORD : env.HARBOR_BREAKING_PASSWORD,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  liveCredentials.set(rec.id, rec);
  return rec;
}

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

async function writePlaylist(entries: ScheduleEntry[]): Promise<void> {
  await mkdir(dirname(env.SCHEDULE_FILE), { recursive: true });
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    if (e.title) lines.push(`#EXTINF:${e.duration_seconds ?? -1},${e.title}`);
    lines.push(e.audio_url);
  }
  await writeFile(env.SCHEDULE_FILE, lines.join("\n") + "\n", "utf8");
}

interface RecordingEntry {
  id: string;
  source: "live" | "breaking";
  filename: string;
  started_at: string;
  duration_seconds: number | null;
  size_bytes: number;
  storage_url: string | null;
}

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

async function listRecordings(sinceIso: string | undefined): Promise<RecordingEntry[]> {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  const results: RecordingEntry[] = [];
  for (const subdir of ["live", "breaking"] as const) {
    const dir = join(env.RECORDINGS_DIR, subdir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of files) {
      const parsed = parseRecordingFilename(filename);
      if (!parsed) continue;
      const filepath = join(dir, filename);
      const st = await stat(filepath).catch(() => null);
      if (!st) continue;
      if (new Date(parsed.started_at).getTime() < since) continue;
      // storage_url is null until the upload-to-FUNK-storage daemon lands.
      // For now the consumer can fetch the file via the radio host if needed,
      // or the operator can ship a syncing job.
      results.push({
        id: filename,
        source: parsed.source,
        filename,
        started_at: parsed.started_at,
        duration_seconds: null,
        size_bytes: st.size,
        storage_url: null,
      });
    }
  }
  results.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return results;
}

const app = new Hono();
app.use("*", cors({ origin: "*", credentials: false }));

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "radio", tenant: env.TENANT_ID });
});

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
  const rec = mintCredential("live", label, ttl);
  return c.json({
    id: rec.id,
    label: rec.label,
    harbor_username: rec.harbor_username,
    harbor_password: rec.harbor_password,
    harbor_host: env.LIQUIDSOAP_HOST,
    harbor_port: 8001,
    harbor_mount: "live",
    expires_at: rec.expires_at,
  });
});

app.get("/v1/radio/live/credentials", (c) => {
  pruneExpired();
  return c.json({
    credentials: [...liveCredentials.values()].map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      created_at: r.created_at,
      expires_at: r.expires_at,
    })),
  });
});

app.delete("/v1/radio/live/credentials/:id", (c) => {
  const ok = liveCredentials.delete(c.req.param("id"));
  return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
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
  const rec = mintCredential("breaking", label, ttl);
  return c.json({
    id: rec.id,
    label: rec.label,
    harbor_username: rec.harbor_username,
    harbor_password: rec.harbor_password,
    harbor_host: env.LIQUIDSOAP_HOST,
    harbor_port: 8002,
    harbor_mount: "breaking",
    expires_at: rec.expires_at,
  });
});

// recordings (discovery only — upload-to-storage daemon is a follow-up)

app.get("/v1/radio/recordings", async (c) => {
  const since = c.req.query("since") ?? undefined;
  try {
    const recordings = await listRecordings(since);
    return c.json({ recordings });
  } catch (err) {
    return c.json({ recordings: [], error: String(err) }, 503);
  }
});

const port = env.PORT;
console.log(`funk-radio listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
