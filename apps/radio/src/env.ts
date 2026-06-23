function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4003),
  TENANT_ID: process.env.TENANT_ID ?? "default",

  // Cross-plane: how radio reaches FUNK's auth + storage services. In dev these
  // can point at host-mapped ports via host.docker.internal; in prod they're
  // the public HTTPS hostnames of the control plane.
  AUTH_URL: required("AUTH_URL"),

  // ADR-004 Slice 3: GET /v1/radio/recordings is answered by listing the
  // control-plane storage `recordings/` prefix (no in-memory index). STORAGE_URL
  // is how radio reaches storage internally; STORAGE_PUBLIC_URL is the host that
  // ends up in each recording's storage_url (must be reachable by the consumer).
  // ADMIN_BOOTSTRAP_TOKEN mints radio's own service credential at startup so it
  // can call the authed listing endpoint (same bootstrap the daemon uses).
  STORAGE_URL: required("STORAGE_URL"),
  STORAGE_PUBLIC_URL: process.env.STORAGE_PUBLIC_URL ?? required("STORAGE_URL"),
  ADMIN_BOOTSTRAP_TOKEN: required("ADMIN_BOOTSTRAP_TOKEN"),

  // Liquidsoap control + filesystem layout (shared volumes with liquidsoap).
  LIQUIDSOAP_HOST: process.env.LIQUIDSOAP_HOST ?? "liquidsoap",
  LIQUIDSOAP_TELNET_PORT: Number(process.env.LIQUIDSOAP_TELNET_PORT ?? 1234),
  SCHEDULE_FILE: process.env.SCHEDULE_FILE ?? "/etc/funk/schedule.m3u",
  RECORDINGS_DIR: process.env.RECORDINGS_DIR ?? "/var/funk/recordings",

  // Durable store for harbor credentials + sessions (ADR-004, Slice 1). A
  // bun:sqlite file on a persistent volume so minted credentials and live
  // sessions survive a radio restart/redeploy. Parent dir is created on boot.
  RADIO_DB_PATH: process.env.RADIO_DB_PATH ?? "/var/funk/radio/radio.db",

  // Shared secret for internal endpoints called by liquidsoap and the recordings
  // daemon. Never exposed publicly — loopback / media_private plane only.
  RADIO_INTERNAL_SECRET: required("RADIO_INTERNAL_SECRET"),
} as const;
