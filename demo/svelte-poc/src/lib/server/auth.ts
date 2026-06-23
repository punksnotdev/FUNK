// Demo admin auth — SERVER-SIDE ONLY.
//
// The demo has no user DB, so credentials are hardcoded into the environment
// (DEMO_ADMIN_USER / DEMO_ADMIN_PASS), read here from $env/dynamic/private so
// they NEVER reach the browser — the same discipline the FUNK service token
// follows in $lib/funk/client.ts.
//
// On a successful login the server sets an httpOnly session cookie holding an
// HMAC of a constant marker, signed with a server-side secret. The browser
// only ever sees the opaque signed value; it can't forge one without the
// secret, and it can't read the password. On each gated request we recompute
// the HMAC and compare — no session store needed for a single-operator demo.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";

export const SESSION_COOKIE = "demo_admin_session";

// The signed value is `HMAC(secret, MARKER)`. It carries no user data — it's a
// pure "this server minted this" proof. Rotating DEMO_SESSION_SECRET (or the
// admin password, indirectly via redeploy) invalidates outstanding cookies.
const MARKER = "demo-admin-v1";

function sessionSecret(): string {
  // Fall back to a password-derived secret so the demo works with zero extra
  // config, while still keeping the cookie unforgeable without the password.
  const explicit = env.DEMO_SESSION_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  const pass = env.DEMO_ADMIN_PASS ?? "";
  return `funk-demo-session::${pass}`;
}

function expectedToken(): string {
  return createHmac("sha256", sessionSecret()).update(MARKER).digest("hex");
}

// Compare the supplied login credentials against the env-configured admin.
// Constant-time on both fields to avoid trivial timing leaks.
export function credentialsMatch(user: string, pass: string): boolean {
  const wantUser = env.DEMO_ADMIN_USER ?? "";
  const wantPass = env.DEMO_ADMIN_PASS ?? "";
  if (wantUser.length === 0 || wantPass.length === 0) return false;
  return safeEqual(user, wantUser) && safeEqual(pass, wantPass);
}

// The opaque value to store in the httpOnly session cookie after login.
export function issueSessionToken(): string {
  return expectedToken();
}

// True iff the cookie value was minted by this server (correct HMAC).
export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  return safeEqual(token, expectedToken());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
