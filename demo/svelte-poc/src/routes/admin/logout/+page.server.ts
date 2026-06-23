// Logout — clears the session cookie and bounces to the login page.
// Implemented as an action so it's a POST (no CSRF-via-link / prefetch logout).

import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE } from "$lib/server/auth";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ cookies }) => {
    cookies.delete(SESSION_COOKIE, { path: "/" });
    throw redirect(303, "/admin/login");
  },
};
