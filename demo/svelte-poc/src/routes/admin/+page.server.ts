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
  //
  // The track source is EITHER an uploaded MP3 file (pushed to FUNK storage,
  // whose stable /files/<key> URL becomes the audio_url) OR a directly-supplied
  // audio_url. The file wins when both are present.
  default: async ({ request, fetch }) => {
    const form = await request.formData();
    let audioUrl = String(form.get("audio_url") ?? "").trim();
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    const artist = String(form.get("artist") ?? "").trim();
    const album = String(form.get("album") ?? "").trim();
    const yearRaw = String(form.get("year") ?? "").trim();
    const genre = String(form.get("genre") ?? "").trim();
    const durationRaw = String(form.get("duration_seconds") ?? "").trim();

    // Preserve the operator's text input so the form can be re-rendered on error.
    // (The file input can't be re-populated for security reasons — the operator
    // re-picks it; we surface a clear error instead.)
    const values = {
      audio_url: audioUrl,
      title,
      artist,
      album,
      year: yearRaw,
      genre,
      duration_seconds: durationRaw,
    };

    let year: number | undefined;
    if (yearRaw.length > 0) {
      const y = Number(yearRaw);
      if (!Number.isInteger(y) || y <= 0) {
        return fail(400, {
          ...values,
          error: "year must be a positive whole number.",
        });
      }
      year = y;
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

    // Upload path: an MP3 file was attached — push it to FUNK storage and use
    // the returned stable URL as the schedule's audio_url. Metadata is stamped
    // on the stored object too, so it can resurface in recordings listings.
    const hasFile = file instanceof File && file.size > 0;
    if (hasFile) {
      const f = file as File;
      const looksAudio =
        f.type.startsWith("audio/") || /\.(mp3|mpeg|mpga)$/i.test(f.name);
      if (!looksAudio) {
        return fail(400, { ...values, error: "Uploaded file must be an MP3 / audio file." });
      }
      try {
        const uploaded = await funk.storage.upload(
          f,
          { title, artist, album, year, genre, duration_seconds: durationSeconds },
          fetch,
        );
        audioUrl = uploaded.url;
      } catch (err) {
        return fail(502, { ...values, error: (err as Error).message });
      }
    }

    if (!audioUrl) {
      return fail(400, { ...values, error: "Provide an MP3 file or an audio_url." });
    }

    try {
      await funk.radio.putSchedule(
        [
          {
            audio_url: audioUrl,
            ...(title ? { title } : {}),
            ...(artist ? { artist } : {}),
            ...(album ? { album } : {}),
            ...(year !== undefined ? { year } : {}),
            ...(genre ? { genre } : {}),
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
