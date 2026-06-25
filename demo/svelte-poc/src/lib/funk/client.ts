// Thin FUNK client — SERVER-SIDE ONLY.
//
// It reads FUNK_RADIO_URL, FUNK_STORAGE_URL and FUNK_SERVICE_TOKEN from
// $env/dynamic/private, which SvelteKit refuses to expose to the browser. The
// service token is sent as `Authorization: Bearer <token>` on every call. The
// key lesson of this demo: that token NEVER reaches the client. Only the
// public, anonymous HLS URL (PUBLIC_FUNK_HLS_URL) is shipped to the browser.

import { env } from "$env/dynamic/private";
import type { NowPlaying, ScheduleEntry, ScheduleWindow } from "./types";

function radioBase(): string {
  const url = env.FUNK_RADIO_URL;
  if (!url) throw new Error("FUNK_RADIO_URL is not set");
  return url.replace(/\/$/, "");
}

function storageBase(): string {
  const url = env.FUNK_STORAGE_URL;
  if (!url) throw new Error("FUNK_STORAGE_URL is not set");
  return url.replace(/\/$/, "");
}

function serviceToken(): string {
  const token = env.FUNK_SERVICE_TOKEN;
  if (!token) throw new Error("FUNK_SERVICE_TOKEN is not set");
  return token;
}

export interface UploadResult {
  id: string;
  key: string;
  bucket: string;
  content_type: string;
  size_bytes: number;
  // Stable, server-hosted URL that 302-redirects to a fresh presigned object
  // URL on each fetch — safe to hand to the radio scheduler as an audio_url.
  url: string;
}

export const funk = {
  storage: {
    // Upload a file to FUNK storage. → POST /uploads (multipart). Returns the
    // stored key plus a stable playable URL (${FUNK_STORAGE_URL}/files/<key>).
    // Optional metadata is stamped onto the object so it can resurface later.
    async upload(
      file: File,
      metadata: Record<string, string | number | undefined> = {},
      fetchImpl: typeof fetch = fetch,
    ): Promise<UploadResult> {
      const fd = new FormData();
      fd.set("file", file);
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(metadata)) {
        if (v === undefined || v === null || v === "") continue;
        cleaned[k] = String(v);
      }
      if (Object.keys(cleaned).length > 0) fd.set("metadata", JSON.stringify(cleaned));

      const res = await fetchImpl(`${storageBase()}/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken()}` },
        body: fd,
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = `${detail} — ${body.error}`;
        } catch {
          /* non-JSON body; keep the status line */
        }
        throw new Error(`FUNK upload failed: ${detail}`);
      }
      const body = (await res.json()) as Omit<UploadResult, "url">;
      return { ...body, url: `${storageBase()}/files/${body.key}` };
    },
  },

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
