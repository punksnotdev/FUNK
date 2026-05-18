import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Role } from "@funk/shared";
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

function requireAdmin(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  return token === env.ADMIN_BOOTSTRAP_TOKEN;
}

const VALID_ROLES = new Set<Role>(["admin", "contributor", "listener"]);

app.post("/invitations", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const role: Role = body.role ?? "contributor";
  if (!VALID_ROLES.has(role)) return c.json({ error: "invalid role" }, 400);

  const note: string | null = typeof body.note === "string" ? body.note : null;
  const token = generateToken();

  const [row] = await sql<Array<{ id: string; created_at: Date }>>`
    INSERT INTO invitations (tenant_id, token_hash, role, note)
    VALUES (${env.TENANT_ID}, ${hashToken(token)}, ${role}, ${note})
    RETURNING id, created_at
  `;

  return c.json({
    id: row!.id,
    role,
    note,
    token,
    created_at: row!.created_at,
  });
});

app.post("/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const invitationToken: unknown = body.invitation;
  if (typeof invitationToken !== "string" || invitationToken.length < 8) {
    return c.json({ error: "invitation required" }, 400);
  }

  const invitationHash = hashToken(invitationToken);

  const result = await sql.begin(async (tx) => {
    const [invitation] = await tx<Array<{
      id: string;
      role: Role;
      used_at: Date | null;
      revoked_at: Date | null;
    }>>`
      SELECT id, role, used_at, revoked_at
      FROM invitations
      WHERE tenant_id = ${env.TENANT_ID} AND token_hash = ${invitationHash}
      FOR UPDATE
    `;
    if (!invitation) return { error: "invalid invitation" as const };
    if (invitation.revoked_at) return { error: "invitation revoked" as const };
    if (invitation.used_at) return { error: "invitation already used" as const };

    await tx`UPDATE invitations SET used_at = now() WHERE id = ${invitation.id}`;

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);

    const [session] = await tx<Array<{ id: string; created_at: Date }>>`
      INSERT INTO sessions (tenant_id, token_hash, invitation_id, role, expires_at)
      VALUES (
        ${env.TENANT_ID},
        ${hashToken(sessionToken)},
        ${invitation.id},
        ${invitation.role},
        ${expiresAt.toISOString()}
      )
      RETURNING id, created_at
    `;

    return {
      session: {
        id: session!.id,
        role: invitation.role,
        created_at: session!.created_at,
        expires_at: expiresAt,
        token: sessionToken,
      },
    };
  });

  if ("error" in result) return c.json({ error: result.error }, 401);
  return c.json(result.session);
});

app.get("/sessions/me", async (c) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
  const token = header.slice("Bearer ".length);

  const [session] = await sql<Array<{
    id: string;
    tenant_id: string;
    role: Role;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  }>>`
    SELECT id, tenant_id, role, created_at, expires_at, revoked_at
    FROM sessions
    WHERE tenant_id = ${env.TENANT_ID} AND token_hash = ${hashToken(token)}
  `;

  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.revoked_at) return c.json({ error: "session revoked" }, 401);
  if (session.expires_at.getTime() < Date.now()) return c.json({ error: "session expired" }, 401);

  return c.json({
    id: session.id,
    tenant_id: session.tenant_id,
    role: session.role,
    created_at: session.created_at,
    expires_at: session.expires_at,
  });
});

app.delete("/sessions/me", async (c) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
  const token = header.slice("Bearer ".length);

  await sql`
    UPDATE sessions SET revoked_at = now()
    WHERE tenant_id = ${env.TENANT_ID} AND token_hash = ${hashToken(token)} AND revoked_at IS NULL
  `;
  return c.body(null, 204);
});

const port = env.PORT;
console.log(`funk-auth listening on :${port} (tenant=${env.TENANT_ID})`);

export default {
  port,
  fetch: app.fetch,
};
