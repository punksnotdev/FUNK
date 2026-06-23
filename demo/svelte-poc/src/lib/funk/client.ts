// Thin FUNK radio client — SERVER-SIDE ONLY.
//
// It reads FUNK_RADIO_URL and FUNK_SERVICE_TOKEN from $env/dynamic/private,
// which SvelteKit refuses to expose to the browser. The service token is sent
// as `Authorization: Bearer <token>` on every control-plane call. The key
// lesson of this demo: that token NEVER reaches the client. Only the public,
// anonymous HLS URL (PUBLIC_FUNK_HLS_URL) is shipped to the browser.

import { env } from "$env/dynamic/private";
import type { NowPlaying, ScheduleEntry, ScheduleWindow } from "./types";

function radioBase(): string {
  const url = env.FUNK_RADIO_URL;
  if (!url) throw new Error("FUNK_RADIO_URL is not set");
  return url.replace(/\/$/, "");
}

function serviceToken(): string {
  const token = env.FUNK_SERVICE_TOKEN;
  if (!token) throw new Error("FUNK_SERVICE_TOKEN is not set");
  return token;
}

export const funk = {
  radio: {
    async nowPlaying(fetchImpl: typeof fetch = fetch): Promise<NowPlaying> {
      const res = await fetchImpl(`${radioBase()}/v1/radio/now-playing`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${serviceToken()}`,
        },
      });
      if (!res.ok) {
        throw new Error(`FUNK now-playing failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as NowPlaying;
    },

    // Read the current radio programming. → GET /v1/radio/schedule.
    async getSchedule(fetchImpl: typeof fetch = fetch): Promise<ScheduleWindow> {
      const res = await fetchImpl(`${radioBase()}/v1/radio/schedule`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${serviceToken()}`,
        },
      });
      if (!res.ok) {
        throw new Error(`FUNK get-schedule failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as ScheduleWindow;
    },

    // Replace the entire radio programming. → PUT /v1/radio/schedule.
    // This is a full replace: the supplied entries become the whole schedule.
    async putSchedule(
      entries: ScheduleEntry[],
      fetchImpl: typeof fetch = fetch,
    ): Promise<{ applied: boolean; entries: number; applied_at: string }> {
      const res = await fetchImpl(`${radioBase()}/v1/radio/schedule`, {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${serviceToken()}`,
        },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) {
        // Surface FUNK's error body when it sends one (e.g. validation 400s).
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = `${detail} — ${body.error}`;
        } catch {
          /* non-JSON body; keep the status line */
        }
        throw new Error(`FUNK put-schedule failed: ${detail}`);
      }
      return (await res.json()) as {
        applied: boolean;
        entries: number;
        applied_at: string;
      };
    },
  },
};
