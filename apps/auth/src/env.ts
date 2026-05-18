function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4001),
  DATABASE_URL: required("DATABASE_URL"),
  TENANT_ID: process.env.TENANT_ID ?? "default",
  ADMIN_BOOTSTRAP_TOKEN: required("ADMIN_BOOTSTRAP_TOKEN"),
  SESSION_TTL_HOURS: Number(process.env.SESSION_TTL_HOURS ?? 720),
} as const;
