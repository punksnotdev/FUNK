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

  // Shared secret guarding the internal harbor credential/session endpoints
  // (ADR-004 Amendment) that `radio` calls. Sent as a bearer by radio; never
  // exposed on the public credential surface.
  AUTH_INTERNAL_SECRET: required("AUTH_INTERNAL_SECRET"),
} as const;
