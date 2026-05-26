import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { sql } from "./db";
import { generateToken, hashToken } from "./tokens";

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

const port = env.PORT;
console.log(`funk-auth listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
