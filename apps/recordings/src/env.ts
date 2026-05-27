function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4004),

  // Where to find FUNK's auth service (to mint the daemon's own credential).
  AUTH_URL: required("AUTH_URL"),

  // Where to find FUNK's storage service (to upload recordings).
  STORAGE_URL: required("STORAGE_URL"),

  // Where to find the radio service (for attribution lookups).
  RADIO_URL: process.env.RADIO_URL ?? "http://radio:4003",

  // Shared secret for internal radio endpoints.
  RADIO_INTERNAL_SECRET: required("RADIO_INTERNAL_SECRET"),

  // Bootstrap token for minting the daemon's own storage credential at startup.
  ADMIN_BOOTSTRAP_TOKEN: required("ADMIN_BOOTSTRAP_TOKEN"),

  // Root of the recordings volume; subdirs live/<mount> and breaking/<mount>.
  RECORDINGS_DIR: process.env.RECORDINGS_DIR ?? "/var/funk/recordings",

  // How many seconds a file's mtime must be stable before we treat it as
  // fully written and ready to upload.
  STABILITY_SECONDS: Number(process.env.STABILITY_SECONDS ?? 30),
} as const;
