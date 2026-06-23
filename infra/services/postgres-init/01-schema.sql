-- FUNK v0 schema. Single-tenant per deployment; tenant_id is here so the
-- eventual multi-tenant migration is additive, not a rewrite.
--
-- Per ADR-001, FUNK is machine-facing: human identity lives in the consumer.
-- The only auth concept here is a service credential issued to a consumer.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS credentials_tenant_idx ON credentials (tenant_id);

CREATE TABLE IF NOT EXISTS files (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              text NOT NULL,
  key                    text NOT NULL UNIQUE,
  bucket                 text NOT NULL,
  content_type           text NOT NULL,
  size_bytes             bigint NOT NULL,
  uploaded_by_credential uuid REFERENCES credentials(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_tenant_idx ON files (tenant_id);

-- Harbor (live broadcast) credentials + sessions (ADR-004 Amendment 2026-06-23).
-- These moved OFF the media plane (Slice 1's bun:sqlite store is removed) and
-- INTO the control-plane auth service so the media plane is fully stateless.
-- The `radio` service delegates persistence + validation here over HTTP via
-- internal endpoints guarded by AUTH_INTERNAL_SECRET. The public
-- POST /v1/radio/live/credentials surface stays on radio; only the storage
-- moved. password_hash is a bcrypt hash (Bun.password); plaintext is returned
-- to radio exactly once at mint time and never stored.

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
);

-- Validation looks up by (mount, username); enforce uniqueness within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS harbor_credentials_mount_username_idx
  ON harbor_credentials (tenant_id, mount, username);

CREATE TABLE IF NOT EXISTS harbor_sessions (
  credential_id   uuid PRIMARY KEY REFERENCES harbor_credentials(id) ON DELETE CASCADE,
  tenant_id       text NOT NULL,
  mount           text NOT NULL,
  label           text NOT NULL,
  connected_at    timestamptz NOT NULL,
  disconnected_at timestamptz
);

-- Attribution lookup scans recent sessions for a given mount.
CREATE INDEX IF NOT EXISTS harbor_sessions_mount_idx ON harbor_sessions (tenant_id, mount);
