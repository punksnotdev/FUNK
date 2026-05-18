import { PUBLIC_AUTH_URL, PUBLIC_STORAGE_URL } from "$env/static/public";

export interface SessionInfo {
  id: string;
  role: "admin" | "contributor" | "listener";
  expires_at: string;
  token: string;
}

export interface UploadInfo {
  id: string;
  key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

export async function createInvitation(
  adminToken: string,
  role: "admin" | "contributor" | "listener" = "contributor",
  note?: string,
): Promise<{ token: string; role: string }> {
  const res = await fetch(`${PUBLIC_AUTH_URL}/invitations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ role, note }),
  });
  if (!res.ok) throw new Error(`createInvitation failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function claimInvitation(invitation: string): Promise<SessionInfo> {
  const res = await fetch(`${PUBLIC_AUTH_URL}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitation }),
  });
  if (!res.ok) throw new Error(`claimInvitation failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return {
    id: body.id,
    role: body.role,
    expires_at: body.expires_at,
    token: body.token,
  };
}

export async function getMe(sessionToken: string) {
  const res = await fetch(`${PUBLIC_AUTH_URL}/sessions/me`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function uploadFile(sessionToken: string, file: File): Promise<UploadInfo> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${PUBLIC_STORAGE_URL}/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`uploadFile failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function fileUrl(key: string): string {
  return `${PUBLIC_STORAGE_URL}/files/${key}`;
}
