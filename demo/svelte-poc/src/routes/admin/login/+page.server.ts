// Login endpoint for the admin area.
//
// The default action compares the submitted credentials against the
// env-configured admin (DEMO_ADMIN_USER / DEMO_ADMIN_PASS) entirely on the
// server, and on success sets an httpOnly session cookie. The password is
// never echoed back and never shipped to the browser.

import { fail, redirect } from "@sveltejs/kit";
import {
  SESSION_COOKIE,
  credentialsMatch,
  issueSessionToken,
} from "$lib/server/auth";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // Already authenticated? Skip the form and go straight to the admin page.
  if (locals.isAdmin) throw redirect(303, "/admin");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const user = String(form.get("user") ?? "");
    const pass = String(form.get("pass") ?? "");

    if (!credentialsMatch(user, pass)) {
      // Re-render with an error; echo back the username only (never the pass).
      return fail(401, { error: "Invalid credentials.", user });
    }

    cookies.set(SESSION_COOKIE, issueSessionToken(), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Marked insecure-friendly for local http dev; on https it still works.
      secure: false,
      maxAge: 60 * 60 * 8, // 8h operator session
    });

    throw redirect(303, "/admin");
  },
};
