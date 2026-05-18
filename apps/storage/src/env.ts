function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4002),
  DATABASE_URL: required("DATABASE_URL"),
  AUTH_INTERNAL_URL: required("AUTH_INTERNAL_URL"),
  TENANT_ID: process.env.TENANT_ID ?? "default",
  S3_ENDPOINT: required("S3_ENDPOINT"),
  // Endpoint baked into presigned URLs returned to clients. Defaults to S3_ENDPOINT
  // for single-host setups; in prod set to the externally-reachable URL (e.g. behind
  // a TLS proxy in front of MinIO, or the public S3 hostname when not using MinIO).
  S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT ?? required("S3_ENDPOINT"),
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY: required("S3_ACCESS_KEY"),
  S3_SECRET_KEY: required("S3_SECRET_KEY"),
  S3_BUCKET: process.env.S3_BUCKET ?? "funk-uploads",
  MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024),
} as const;
