import { browser } from "$app/environment";

const STORAGE_KEY = "funk.session";

interface StoredSession {
  token: string;
  role: "admin" | "contributor" | "listener";
  expires_at: string;
}

function load(): StoredSession | null {
  if (!browser) return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export const session = $state<{ current: StoredSession | null }>({ current: load() });

export function setSession(s: StoredSession | null): void {
  session.current = s;
  if (!browser) return;
  if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORAGE_KEY);
}
