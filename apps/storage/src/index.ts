import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Role } from "@funk/shared";
import { env } from "./env";

const sql = postgres(env.DATABASE_URL, { max: 10, idle_timeout: 30 });

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

// Separate client whose endpoint matches what *clients* can reach; used only for
// generating presigned URLs that are returned to browsers.
const s3Public = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

interface AuthSession {
  id: string;
  tenant_id: string;
  role: Role;
}

async function resolveSession(authHeader: string | undefined): Promise<AuthSession | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.AUTH_INTERNAL_URL}/sessions/me`, {
    headers: { authorization: authHeader },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthSession;
}

const app = new Hono();

app.use("*", cors({ origin: "*", credentials: false }));

app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ status: "ok", service: "storage", tenant: env.TENANT_ID, bucket: env.S3_BUCKET });
  } catch (err) {
    return c.json({ status: "error", error: String(err) }, 503);
  }
});

app.post("/uploads", async (c) => {
  const session = await resolveSession(c.req.header("authorization"));
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.role === "listener") return c.json({ error: "forbidden" }, 403);

  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);
  if (file.size > env.MAX_UPLOAD_BYTES) return c.json({ error: "file too large" }, 413);

  const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
  const key = `${env.TENANT_ID}/${new Date().toISOString().slice(0, 10)}/${randomBytes(16).toString("hex")}${ext}`;
  const buffer = new Uint8Array(await file.arrayBuffer());

  await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: file.type || "application/octet-stream",
  }));

  const [row] = await sql<Array<{ id: string; created_at: Date }>>`
    INSERT INTO files (tenant_id, key, bucket, content_type, size_bytes, uploaded_by)
    VALUES (
      ${env.TENANT_ID},
      ${key},
      ${env.S3_BUCKET},
      ${file.type || "application/octet-stream"},
      ${file.size},
      ${session.id}
    )
    RETURNING id, created_at
  `;

  return c.json({
    id: row!.id,
    key,
    bucket: env.S3_BUCKET,
    content_type: file.type || "application/octet-stream",
    size_bytes: file.size,
    created_at: row!.created_at,
  });
});

app.get("/files/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const [row] = await sql<Array<{ key: string; bucket: string; content_type: string }>>`
    SELECT key, bucket, content_type FROM files
    WHERE tenant_id = ${env.TENANT_ID} AND key = ${key}
  `;
  if (!row) return c.json({ error: "not found" }, 404);

  const url = await getSignedUrl(
    s3Public,
    new GetObjectCommand({ Bucket: row.bucket, Key: row.key }),
    { expiresIn: 300 },
  );
  return c.redirect(url, 302);
});

const port = env.PORT;
console.log(`funk-storage listening on :${port} (tenant=${env.TENANT_ID}, bucket=${env.S3_BUCKET})`);

export default {
  port,
  fetch: app.fetch,
};
