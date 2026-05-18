export type Role = "admin" | "contributor" | "listener";

export interface Session {
  id: string;
  tenant_id: string;
  role: Role;
  created_at: string;
  expires_at: string;
}

export interface Invitation {
  id: string;
  tenant_id: string;
  role: Role;
  note: string | null;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
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
