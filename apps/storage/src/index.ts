import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
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

  // Optional user metadata: a JSON object of string→string pairs supplied as a
  // `metadata` form field. Stamped onto the S3 object (x-amz-meta-*) so it can
  // be read back later via HeadObject (used by the recordings listing to expose
  // duration_seconds/started_at without an index). Keys are lowercased and
  // restricted to [a-z0-9-]; values are coerced to strings and length-capped.
  let s3Metadata: Record<string, string> | undefined;
  if (typeof form.metadata === "string") {
    try {
      const parsed = JSON.parse(form.metadata) as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === null || v === undefined) continue;
        const safeKey = k.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
        if (!safeKey) continue;
        cleaned[safeKey] = String(v).slice(0, 256);
      }
      if (Object.keys(cleaned).length > 0) s3Metadata = cleaned;
    } catch {
      return c.json({ error: "metadata must be a JSON object" }, 400);
    }
  }

  await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: file.type || "application/octet-stream",
    ...(s3Metadata ? { Metadata: s3Metadata } : {}),
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

// List objects under a prefix. Authed (any valid FUNK credential). Returns the
// tenant-stripped logical key (the same key clients supply on upload and pass to
// GET /files/<key>), size, and — when ?metadata=1 — the user metadata stamped at
// upload time. Backs ADR-004 Slice 3: radio derives its recordings index by
// listing `recordings/` instead of holding an in-memory copy. Plane isolation
// holds: radio calls this over HTTP, never MinIO directly.
app.get("/files", async (c) => {
  const credential = await resolveCredential(c.req.header("authorization"));
  if (!credential) return c.json({ error: "unauthorized" }, 401);

  const rawPrefix = c.req.query("prefix") ?? "";
  // The same sanitizer as upload, but allow an empty prefix (list-all under the
  // tenant) and a trailing slash (a directory prefix, not a full key).
  if (rawPrefix) {
    if (rawPrefix.length > 256 || rawPrefix.startsWith("/")) {
      return c.json({ error: "invalid prefix" }, 400);
    }
    if (!/^[a-zA-Z0-9._/-]+$/.test(rawPrefix)) {
      return c.json({ error: "invalid prefix" }, 400);
    }
    if (rawPrefix.split("/").some((seg) => seg === "." || seg === "..")) {
      return c.json({ error: "invalid prefix" }, 400);
    }
  }
  const withMetadata = c.req.query("metadata") === "1";

  // The tenant prefix is always applied server-side; clients never see it.
  const s3Prefix = `${env.TENANT_ID}/${rawPrefix}`;
  const tenantPrefix = `${env.TENANT_ID}/`;

  const objects: Array<{ key: string; size_bytes: number; metadata?: Record<string, string> }> = [];
  let continuationToken: string | undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: env.S3_BUCKET,
      Prefix: s3Prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of out.Contents ?? []) {
      if (!obj.Key) continue;
      // Strip the tenant prefix so callers see the same logical key they upload.
      const logicalKey = obj.Key.startsWith(tenantPrefix) ? obj.Key.slice(tenantPrefix.length) : obj.Key;
      objects.push({ key: logicalKey, size_bytes: obj.Size ?? 0 });
    }
    continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (continuationToken);

  if (withMetadata) {
    // HeadObject per key to surface x-amz-meta-* (ListObjectsV2 omits it). N is
    // small for the recordings prefix; if this ever grows, paginate or cache.
    await Promise.all(objects.map(async (o) => {
      try {
        const head = await s3.send(new HeadObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: `${tenantPrefix}${o.key}`,
        }));
        if (head.Metadata && Object.keys(head.Metadata).length > 0) {
          o.metadata = head.Metadata as Record<string, string>;
        }
      } catch {
        // Object may have been deleted between list and head; skip its metadata.
      }
    }));
  }

  return c.json({ objects });
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
