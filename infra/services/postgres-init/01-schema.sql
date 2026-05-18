-- FUNK v0 schema. Single-tenant per deployment; tenant_id is here so the
-- eventual multi-tenant migration is additive, not a rewrite.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('admin', 'contributor', 'listener')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS invitations_tenant_idx ON invitations (tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  invitation_id  uuid REFERENCES invitations(id) ON DELETE SET NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'contributor', 'listener')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions (tenant_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  key           text NOT NULL UNIQUE,
  bucket        text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  uploaded_by   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_tenant_idx ON files (tenant_id);
