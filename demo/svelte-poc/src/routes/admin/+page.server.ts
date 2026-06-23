// Admin programming page — view + set the radio schedule.
//
// The auth gate lives in hooks.server.ts; by the time this load/action runs the
// request is guaranteed to carry a valid admin session. All FUNK calls go
// through the server-only client, so the FUNK_SERVICE_TOKEN never reaches the
// browser.

import { fail, redirect } from "@sveltejs/kit";
import { funk } from "$lib/funk/client";
import type { ScheduleWindow } from "$lib/funk/types";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const schedule = await funk.radio.getSchedule(fetch);
    return { schedule, loadError: null as string | null };
  } catch (err) {
    // Degrade gracefully — render the page with an error instead of a 500 so
    // the operator can still attempt to set a new schedule.
    const empty: ScheduleWindow = { applied_at: null, entries: [] };
    return { schedule: empty, loadError: (err as Error).message };
  }
};

export const actions: Actions = {
  // Replace the whole schedule with a single entry built from the form.
  // PUT /v1/radio/schedule is a full replace — see the page note.
  default: async ({ request, fetch }) => {
    const form = await request.formData();
    const audioUrl = String(form.get("audio_url") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const durationRaw = String(form.get("duration_seconds") ?? "").trim();

    // Preserve the operator's input so the form can be re-rendered on error.
    const values = { audio_url: audioUrl, title, duration_seconds: durationRaw };

    if (!audioUrl) {
      return fail(400, { ...values, error: "audio_url is required." });
    }

    let durationSeconds: number | undefined;
    if (durationRaw.length > 0) {
      const n = Number(durationRaw);
      if (!Number.isFinite(n) || n <= 0) {
        return fail(400, {
          ...values,
          error: "duration_seconds must be a positive number.",
        });
      }
      durationSeconds = n;
    }

    try {
      await funk.radio.putSchedule(
        [
          {
            audio_url: audioUrl,
            ...(title ? { title } : {}),
            ...(durationSeconds !== undefined
              ? { duration_seconds: durationSeconds }
              : {}),
          },
        ],
        fetch,
      );
    } catch (err) {
      // Surface FUNK's error to the form.
      return fail(502, { ...values, error: (err as Error).message });
    }

    // Re-render with the freshly-applied schedule.
    throw redirect(303, "/admin");
  },
};
