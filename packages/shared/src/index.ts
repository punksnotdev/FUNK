// Shared types for FUNK's internal services and consumer integrations.
// FUNK is machine-facing (ADR-001); the only auth concept is a service credential.

export interface Credential {
  id: string;
  tenant_id: string;
  label: string;
  created_at: string;
}

export interface FileRecord {
  id: string;
  tenant_id: string;
  key: string;
  bucket: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}
