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
