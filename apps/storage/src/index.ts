import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

interface ResolvedCredential {
  id: string;
  tenant_id: string;
  label: string;
}

async function resolveCredential(authHeader: string | undefined): Promise<ResolvedCredential | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.AUTH_INTERNAL_URL}/v1/credentials/me`, {
    headers: { authorization: authHeader },
  });
  if (!res.ok) return null;
  return (await res.json()) as ResolvedCredential;
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

// Reject anything outside [a-zA-Z0-9._/-], leading slashes, .. traversal,
// or longer than 256 chars. The tenant_id prefix is added by the server.
function sanitizeStorageKey(raw: string): string | null {
  if (!raw || raw.length > 256) return null;
  if (raw.startsWith("/")) return null;
  if (raw.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  if (!/^[a-zA-Z0-9._/-]+$/.test(raw)) return null;
  return raw;
}

app.post("/uploads", async (c) => {
  const credential = await resolveCredential(c.req.header("authorization"));
  if (!credential) return c.json({ error: "unauthorized" }, 401);

  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);
  if (file.size > env.MAX_UPLOAD_BYTES) return c.json({ error: "file too large" }, 413);

  // Honor a client-supplied storage_key when present and well-formed. The
  // tenant prefix is always enforced by the server.
  const suppliedKey = typeof form.storage_key === "string" ? sanitizeStorageKey(form.storage_key) : null;
  let key: string;
  if (suppliedKey) {
    key = `${env.TENANT_ID}/${suppliedKey}`;
  } else {
    const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
    key = `${env.TENANT_ID}/${new Date().toISOString().slice(0, 10)}/${randomBytes(16).toString("hex")}${ext}`;
  }
  const buffer = new Uint8Array(await file.arrayBuffer());

  await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: file.type || "application/octet-stream",
  }));

  // ON CONFLICT: client-supplied keys may be re-uploaded (idempotent retry).
  // We overwrite the row to reflect the latest upload metadata; the underlying
  // S3 PUT above has already overwritten the object bytes.
  const [row] = await sql<Array<{ id: string; created_at: Date }>>`
    INSERT INTO files (tenant_id, key, bucket, content_type, size_bytes, uploaded_by_credential)
    VALUES (
      ${env.TENANT_ID},
      ${key},
      ${env.S3_BUCKET},
      ${file.type || "application/octet-stream"},
      ${file.size},
      ${credential.id}
    )
    ON CONFLICT (key) DO UPDATE SET
      content_type = EXCLUDED.content_type,
      size_bytes = EXCLUDED.size_bytes,
      uploaded_by_credential = EXCLUDED.uploaded_by_credential
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
