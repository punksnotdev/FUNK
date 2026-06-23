import postgres from "postgres";
import { env } from "./env";

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
});

// Idempotent boot migration for the harbor credentials + sessions tables
// (ADR-004 Amendment 2026-06-23 — credentials/sessions moved off the media
// plane into auth's Postgres). postgres-init/01-schema.sql only runs on a
// fresh data volume, so we also ensure the schema here so an existing dev
// volume is upgraded in place. CREATE TABLE IF NOT EXISTS is a no-op when the
// init script already created them. Kept in sync with 01-schema.sql.
export async function ensureHarborSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS harbor_credentials (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     text NOT NULL,
      label         text NOT NULL,
      mount         text NOT NULL,
      username      text NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      revoked_at    timestamptz
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS harbor_credentials_mount_username_idx
      ON harbor_credentials (tenant_id, mount, username)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS harbor_sessions (
      credential_id   uuid PRIMARY KEY REFERENCES harbor_credentials(id) ON DELETE CASCADE,
      tenant_id       text NOT NULL,
      mount           text NOT NULL,
      label           text NOT NULL,
      connected_at    timestamptz NOT NULL,
      disconnected_at timestamptz
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS harbor_sessions_mount_idx
      ON harbor_sessions (tenant_id, mount)
  `;
}
