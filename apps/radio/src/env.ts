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

  // Liquidsoap control + filesystem layout (shared volumes with liquidsoap).
  LIQUIDSOAP_HOST: process.env.LIQUIDSOAP_HOST ?? "liquidsoap",
  LIQUIDSOAP_TELNET_PORT: Number(process.env.LIQUIDSOAP_TELNET_PORT ?? 1234),
  SCHEDULE_FILE: process.env.SCHEDULE_FILE ?? "/etc/funk/schedule.m3u",
  RECORDINGS_DIR: process.env.RECORDINGS_DIR ?? "/var/funk/recordings",

  // Static harbor passwords in v0. Per-host credential rotation is a
  // follow-up; until then funk-radio's /v1/radio/live/credentials endpoints
  // mint *bearer tokens* that consumers map onto the shared harbor mount.
  HARBOR_LIVE_PASSWORD: required("HARBOR_LIVE_PASSWORD"),
  HARBOR_BREAKING_PASSWORD: required("HARBOR_BREAKING_PASSWORD"),
} as const;
