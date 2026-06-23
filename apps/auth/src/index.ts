import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { sql, ensureHarborSchema } from "./db";
import { generateToken, hashToken } from "./tokens";

// Ensure the harbor credentials/sessions tables exist (ADR-004 Amendment). Runs
// once at boot; idempotent. await at module top-level so the internal endpoints
// never race the schema on the first request.
await ensureHarborSchema();

const app = new Hono();

app.use("*", cors({ origin: "*", credentials: false }));

app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ status: "ok", service: "auth", tenant: env.TENANT_ID });
  } catch (err) {
    return c.json({ status: "error", error: String(err) }, 503);
  }
});

function authorizedAsAdmin(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === env.ADMIN_BOOTSTRAP_TOKEN;
}

app.post("/v1/credentials", async (c) => {
  if (!authorizedAsAdmin(c)) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const label: string = typeof body.label === "string" && body.label.length > 0
    ? body.label
    : "unlabeled";

  const token = generateToken();

  const [row] = await sql<Array<{ id: string; created_at: Date }>>`
    INSERT INTO credentials (tenant_id, token_hash, label)
    VALUES (${env.TENANT_ID}, ${hashToken(token)}, ${label})
    RETURNING id, created_at
  `;

  return c.json({
    id: row!.id,
    label,
    token,
    created_at: row!.created_at,
  });
});

app.get("/v1/credentials", async (c) => {
  if (!authorizedAsAdmin(c)) return c.json({ error: "unauthorized" }, 401);

  const rows = await sql<Array<{
    id: string;
    label: string;
    created_at: Date;
    revoked_at: Date | null;
  }>>`
    SELECT id, label, created_at, revoked_at
    FROM credentials
    WHERE tenant_id = ${env.TENANT_ID}
    ORDER BY created_at DESC
  `;
  return c.json({ credentials: rows });
});

app.delete("/v1/credentials/:id", async (c) => {
  if (!authorizedAsAdmin(c)) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");

  const result = await sql`
    UPDATE credentials SET revoked_at = now()
    WHERE tenant_id = ${env.TENANT_ID} AND id = ${id} AND revoked_at IS NULL
  `;
  return c.json({ revoked: result.count });
});

// Internal: validate a bearer credential. Called by storage / radio so each
// service doesn't need to query the credentials table directly.
app.get("/v1/credentials/me", async (c) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
  const token = header.slice("Bearer ".length);

  const [credential] = await sql<Array<{
    id: string;
    tenant_id: string;
    label: string;
    created_at: Date;
    revoked_at: Date | null;
  }>>`
    SELECT id, tenant_id, label, created_at, revoked_at
    FROM credentials
    WHERE tenant_id = ${env.TENANT_ID} AND token_hash = ${hashToken(token)}
  `;

  if (!credential) return c.json({ error: "unauthorized" }, 401);
  if (credential.revoked_at) return c.json({ error: "credential revoked" }, 401);

  return c.json({
    id: credential.id,
    tenant_id: credential.tenant_id,
    label: credential.label,
    created_at: credential.created_at,
  });
});

// --- Internal harbor credential + session endpoints (ADR-004 Amendment) -----
//
// `radio` (media plane) delegates harbor credential persistence + validation
// and session/attribution bookkeeping here over HTTP. These are NOT public:
// they live under /v1/internal/harbor/* and are guarded by AUTH_INTERNAL_SECRET
// (a shared secret radio sends as a bearer), distinct from the admin token that
// guards the public credential surface. Pruning of expired credentials and old
// (7-day) sessions lives here as SQL.

const SESSION_RETENTION_DAYS = 7;
// Attribution tolerance: a recording's started_at may fall slightly outside the
// session window (liquidsoap output.file timestamp vs. harbor connect time).
const ATTRIBUTION_TOLERANCE_SECONDS = 30;

function authorizedInternal(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === env.AUTH_INTERNAL_SECRET;
}

// Mint a harbor credential. radio supplies the username/label/mount/ttl and the
// already-generated plaintext password; auth hashes it (bcrypt via Bun.password)
// and stores it. The plaintext is NOT persisted — radio returns it once to the
// consumer. We hash here (rather than accept a hash) so the password never has a
// trust path through the media plane's storage.
app.post("/v1/internal/harbor/credentials", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    mount?: string;
    label?: string;
    username?: string;
    password?: string;
    ttl_seconds?: number;
  } | null;
  if (!body?.mount || !body?.label || !body?.username || !body?.password || !body?.ttl_seconds) {
    return c.json({ error: "mount, label, username, password, ttl_seconds required" }, 400);
  }

  // Prune expired credentials on the mint path (cheap, keeps the table tidy).
  await sql`DELETE FROM harbor_credentials WHERE tenant_id = ${env.TENANT_ID} AND expires_at < now()`;

  const passwordHash = await Bun.password.hash(body.password, "bcrypt");
  const expiresAt = new Date(Date.now() + body.ttl_seconds * 1000).toISOString();

  const [row] = await sql<Array<{ id: string; created_at: Date; expires_at: Date }>>`
    INSERT INTO harbor_credentials
      (tenant_id, label, mount, username, password_hash, expires_at)
    VALUES
      (${env.TENANT_ID}, ${body.label}, ${body.mount}, ${body.username}, ${passwordHash}, ${expiresAt})
    RETURNING id, created_at, expires_at
  `;

  return c.json({
    credential_id: row!.id,
    label: body.label,
    mount: body.mount,
    username: body.username,
    created_at: row!.created_at,
    expires_at: row!.expires_at,
  });
});

// Validate a harbor connection: (mount, username, password) → verify the hash,
// check not expired/revoked. On success, radio records the session start via the
// sessions endpoint; we keep validate side-effect-free so radio's cache can read
// through it freely.
app.post("/v1/internal/harbor/validate", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    mount?: string;
    username?: string;
    password?: string;
  } | null;
  if (!body?.mount || !body?.username || !body?.password) {
    return c.json({ valid: false }, 200);
  }

  const [cred] = await sql<Array<{
    id: string;
    label: string;
    password_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>>`
    SELECT id, label, password_hash, expires_at, revoked_at
    FROM harbor_credentials
    WHERE tenant_id = ${env.TENANT_ID} AND mount = ${body.mount} AND username = ${body.username}
    LIMIT 1
  `;
  if (!cred) return c.json({ valid: false }, 200);
  if (cred.revoked_at) return c.json({ valid: false }, 200);
  if (new Date(cred.expires_at).getTime() < Date.now()) return c.json({ valid: false }, 200);

  const ok = await Bun.password.verify(body.password, cred.password_hash);
  if (!ok) return c.json({ valid: false }, 200);

  return c.json({ valid: true, credential_id: cred.id, label: cred.label }, 200);
});

// List harbor credentials (non-secret fields only). Prunes expired first so the
// list matches what would validate.
app.get("/v1/internal/harbor/credentials", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  await sql`DELETE FROM harbor_credentials WHERE tenant_id = ${env.TENANT_ID} AND expires_at < now()`;

  const rows = await sql<Array<{
    id: string;
    label: string;
    mount: string;
    username: string;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  }>>`
    SELECT id, label, mount, username, created_at, expires_at, revoked_at
    FROM harbor_credentials
    WHERE tenant_id = ${env.TENANT_ID}
    ORDER BY created_at
  `;
  return c.json({ credentials: rows });
});

// Revoke a harbor credential by id. Returns { revoked: boolean }.
app.delete("/v1/internal/harbor/credentials/:id", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");

  const [existing] = await sql<Array<{ id: string }>>`
    SELECT id FROM harbor_credentials
    WHERE tenant_id = ${env.TENANT_ID} AND id = ${id}
  `;
  if (!existing) return c.json({ revoked: false }, 404);

  await sql`
    UPDATE harbor_credentials SET revoked_at = now()
    WHERE tenant_id = ${env.TENANT_ID} AND id = ${id} AND revoked_at IS NULL
  `;
  return c.json({ revoked: true });
});

// Record a session start (harbor connect). Upserts by credential_id, mirroring
// the old Map.set semantics: a reconnect on the same credential resets the
// window and clears disconnected_at. Prunes old sessions on the way in.
app.post("/v1/internal/harbor/sessions/start", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    credential_id?: string;
    mount?: string;
    label?: string;
    connected_at?: string;
  } | null;
  if (!body?.credential_id || !body?.mount || !body?.label || !body?.connected_at) {
    return c.json({ error: "credential_id, mount, label, connected_at required" }, 400);
  }

  await sql`
    DELETE FROM harbor_sessions
    WHERE tenant_id = ${env.TENANT_ID}
      AND disconnected_at IS NOT NULL
      AND disconnected_at < now() - make_interval(days => ${SESSION_RETENTION_DAYS})
  `;

  await sql`
    INSERT INTO harbor_sessions (credential_id, tenant_id, mount, label, connected_at, disconnected_at)
    VALUES (${body.credential_id}, ${env.TENANT_ID}, ${body.mount}, ${body.label}, ${body.connected_at}, NULL)
    ON CONFLICT (credential_id) DO UPDATE SET
      mount = EXCLUDED.mount,
      label = EXCLUDED.label,
      connected_at = EXCLUDED.connected_at,
      disconnected_at = NULL
  `;
  return c.json({ ok: true });
});

// Record a session end (harbor disconnect). Accepts credential_id directly, or
// resolves the currently-connected credential for a mount (liquidsoap's
// on_disconnect has no credential context).
app.post("/v1/internal/harbor/sessions/end", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    credential_id?: string;
    mount?: string;
    disconnected_at?: string;
  } | null;
  if (!body?.disconnected_at || (!body?.credential_id && !body?.mount)) {
    return c.json({ error: "disconnected_at and (credential_id or mount) required" }, 400);
  }

  let credentialId = body.credential_id ?? null;
  if (!credentialId && body.mount) {
    const [active] = await sql<Array<{ credential_id: string }>>`
      SELECT credential_id FROM harbor_sessions
      WHERE tenant_id = ${env.TENANT_ID} AND mount = ${body.mount} AND disconnected_at IS NULL
      LIMIT 1
    `;
    credentialId = active?.credential_id ?? null;
  }
  if (!credentialId) return c.json({ ok: false }, 200);

  await sql`
    UPDATE harbor_sessions SET disconnected_at = ${body.disconnected_at}
    WHERE tenant_id = ${env.TENANT_ID} AND credential_id = ${credentialId}
  `;
  return c.json({ ok: true });
});

// Attribution lookup: find the session whose window contains started_at (within
// ±tolerance) for a mount. Mirrors radio's old findAttribution.
app.get("/v1/internal/harbor/attribution", async (c) => {
  if (!authorizedInternal(c)) return c.json({ error: "unauthorized" }, 401);

  const mount = c.req.query("mount");
  const startedAt = c.req.query("started_at");
  if (!mount || !startedAt) return c.json({ error: "mount and started_at required" }, 400);

  const ts = new Date(startedAt);
  if (Number.isNaN(ts.getTime())) return c.json({ error: "invalid started_at" }, 400);

  const [row] = await sql<Array<{ credential_id: string; label: string }>>`
    SELECT credential_id, label
    FROM harbor_sessions
    WHERE tenant_id = ${env.TENANT_ID}
      AND mount = ${mount}
      AND connected_at - make_interval(secs => ${ATTRIBUTION_TOLERANCE_SECONDS}) <= ${ts.toISOString()}
      AND COALESCE(disconnected_at, now()) + make_interval(secs => ${ATTRIBUTION_TOLERANCE_SECONDS}) >= ${ts.toISOString()}
    ORDER BY connected_at DESC
    LIMIT 1
  `;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ credential_id: row.credential_id, label: row.label }, 200);
});

const port = env.PORT;
console.log(`funk-auth listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
