// Server hook — the auth gate for the admin area.
//
// Every /admin request (except the login + logout endpoints) is checked here:
// without a valid, server-minted session cookie the request is redirected to
// /admin/login. The validation happens entirely server-side; the password and
// the FUNK token never leave the server. We also stash the authentication
// state on `event.locals` so load functions / actions can read it cheaply.

import { redirect, type Handle } from "@sveltejs/kit";
import { SESSION_COOKIE, isValidSession } from "$lib/server/auth";

// Paths under /admin that an UNauthenticated visitor may reach.
const PUBLIC_ADMIN_PATHS = new Set(["/admin/login", "/admin/logout"]);

export const handle: Handle = async ({ event, resolve }) => {
  const authed = isValidSession(event.cookies.get(SESSION_COOKIE));
  event.locals.isAdmin = authed;

  const { pathname } = event.url;
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");

  if (isAdminArea && !PUBLIC_ADMIN_PATHS.has(pathname) && !authed) {
    throw redirect(303, "/admin/login");
  }

  return resolve(event);
};
