// Durable store for harbor credentials + sessions (ADR-004, Slice 1).
//
// Replaces the in-memory Maps that previously held liveCredentials, sessions,
// and activeSessions. The media plane stays stateless for everything whose
// source of truth lives elsewhere, but harbor-auth is on the critical path of
// going live, so this one small store is media-plane-local and durable: a
// bun:sqlite file on a persistent volume. In-memory was the bug; this restores
// credential/session survival across radio restart, crash, OOM, or redeploy.
//
// bun:sqlite is built into the Bun runtime — no new dependency.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";

export interface LiveCredentialRecord {
  id: string;
  label: string;
  mount: "live" | "breaking";
  username: string;
  password_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SessionRecord {
  credential_id: string;
  mount: string;
  label: string;
  connected_at: string;
  disconnected_at: string | null;
}

// Open the database at RADIO_DB_PATH, creating the parent directory and the
// schema on boot if absent. WAL keeps concurrent reads/writes from blocking.
const dbPath = env.RADIO_DB_PATH;
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS credentials (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    mount         TEXT NOT NULL,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    credential_id   TEXT PRIMARY KEY,
    mount           TEXT NOT NULL,
    label           TEXT NOT NULL,
    connected_at    TEXT NOT NULL,
    disconnected_at TEXT
  );
`);

// activeSessions equivalent (mount → current credential_id) is derived from
// sessions where disconnected_at IS NULL — no separate table needed.

// --- credentials ------------------------------------------------------------

const insertCredentialStmt = db.query(`
  INSERT INTO credentials
    (id, label, mount, username, password_hash, created_at, expires_at, revoked_at)
  VALUES
    ($id, $label, $mount, $username, $password_hash, $created_at, $expires_at, $revoked_at)
`);

const deleteExpiredCredentialsStmt = db.query(
  `DELETE FROM credentials WHERE expires_at < $now`,
);

const selectCredentialByMountUsernameStmt = db.query(
  `SELECT * FROM credentials WHERE mount = $mount AND username = $username LIMIT 1`,
);

const selectCredentialByIdStmt = db.query(
  `SELECT * FROM credentials WHERE id = $id LIMIT 1`,
);

const selectAllCredentialsStmt = db.query(
  `SELECT * FROM credentials ORDER BY created_at`,
);

const revokeCredentialStmt = db.query(
  `UPDATE credentials SET revoked_at = $revoked_at WHERE id = $id`,
);

interface CredentialRow {
  id: string;
  label: string;
  mount: string;
  username: string;
  password_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function rowToCredential(row: CredentialRow): LiveCredentialRecord {
  return {
    id: row.id,
    label: row.label,
    mount: row.mount as "live" | "breaking",
    username: row.username,
    password_hash: row.password_hash,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

// Delete expired credentials (expires_at strictly in the past). Matches the
// old pruneExpired() which dropped any credential past its TTL.
export function pruneExpiredCredentials(): void {
  deleteExpiredCredentialsStmt.run({ $now: new Date().toISOString() });
}

export function insertCredential(rec: LiveCredentialRecord): void {
  insertCredentialStmt.run({
    $id: rec.id,
    $label: rec.label,
    $mount: rec.mount,
    $username: rec.username,
    $password_hash: rec.password_hash,
    $created_at: rec.created_at,
    $expires_at: rec.expires_at,
    $revoked_at: rec.revoked_at,
  });
}

export function getCredentialByMountUsername(
  mount: string,
  username: string,
): LiveCredentialRecord | null {
  const row = selectCredentialByMountUsernameStmt.get({
    $mount: mount,
    $username: username,
  }) as CredentialRow | null;
  return row ? rowToCredential(row) : null;
}

export function listCredentials(): LiveCredentialRecord[] {
  const rows = selectAllCredentialsStmt.all() as CredentialRow[];
  return rows.map(rowToCredential);
}

// Revoke a credential by id. Returns true if the credential existed.
export function revokeCredential(id: string, revokedAt: string): boolean {
  const existing = selectCredentialByIdStmt.get({ $id: id }) as CredentialRow | null;
  if (!existing) return false;
  revokeCredentialStmt.run({ $id: id, $revoked_at: revokedAt });
  return true;
}

// --- sessions ---------------------------------------------------------------

// Upsert keyed by credential_id, mirroring the old Map.set(credentialId, ...).
const upsertSessionStmt = db.query(`
  INSERT INTO sessions (credential_id, mount, label, connected_at, disconnected_at)
  VALUES ($credential_id, $mount, $label, $connected_at, NULL)
  ON CONFLICT(credential_id) DO UPDATE SET
    mount = excluded.mount,
    label = excluded.label,
    connected_at = excluded.connected_at,
    disconnected_at = NULL
`);

const deleteOldSessionsStmt = db.query(
  `DELETE FROM sessions WHERE disconnected_at IS NOT NULL AND disconnected_at < $cutoff`,
);

const selectActiveCredentialForMountStmt = db.query(
  `SELECT credential_id FROM sessions WHERE mount = $mount AND disconnected_at IS NULL LIMIT 1`,
);

const selectSessionByIdStmt = db.query(
  `SELECT * FROM sessions WHERE credential_id = $credential_id LIMIT 1`,
);

const endSessionStmt = db.query(
  `UPDATE sessions SET disconnected_at = $disconnected_at WHERE credential_id = $credential_id`,
);

const selectSessionsByMountStmt = db.query(
  `SELECT * FROM sessions WHERE mount = $mount`,
);

interface SessionRow {
  credential_id: string;
  mount: string;
  label: string;
  connected_at: string;
  disconnected_at: string | null;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    credential_id: row.credential_id,
    mount: row.mount,
    label: row.label,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
  };
}

// Delete sessions disconnected longer than the cutoff (7-day window).
export function pruneOldSessions(cutoffIso: string): void {
  deleteOldSessionsStmt.run({ $cutoff: cutoffIso });
}

export function upsertSession(s: SessionRecord): void {
  upsertSessionStmt.run({
    $credential_id: s.credential_id,
    $mount: s.mount,
    $label: s.label,
    $connected_at: s.connected_at,
  });
}

// mount → credential_id for the currently-connected source (disconnected_at IS NULL).
export function getActiveCredentialForMount(mount: string): string | null {
  const row = selectActiveCredentialForMountStmt.get({ $mount: mount }) as
    | { credential_id: string }
    | null;
  return row ? row.credential_id : null;
}

export function getSession(credentialId: string): SessionRecord | null {
  const row = selectSessionByIdStmt.get({ $credential_id: credentialId }) as
    | SessionRow
    | null;
  return row ? rowToSession(row) : null;
}

// Mark a session disconnected. Returns true if the session existed.
export function endSession(credentialId: string, disconnectedAt: string): boolean {
  const existing = selectSessionByIdStmt.get({ $credential_id: credentialId }) as
    | SessionRow
    | null;
  if (!existing) return false;
  endSessionStmt.run({ $credential_id: credentialId, $disconnected_at: disconnectedAt });
  return true;
}

export function listSessionsByMount(mount: string): SessionRecord[] {
  const rows = selectSessionsByMountStmt.all({ $mount: mount }) as SessionRow[];
  return rows.map(rowToSession);
}
