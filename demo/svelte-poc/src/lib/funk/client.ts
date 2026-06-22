// Thin FUNK radio client — SERVER-SIDE ONLY.
//
// It reads FUNK_RADIO_URL and FUNK_SERVICE_TOKEN from $env/dynamic/private,
// which SvelteKit refuses to expose to the browser. The service token is sent
// as `Authorization: Bearer <token>` on every control-plane call. The key
// lesson of this demo: that token NEVER reaches the client. Only the public,
// anonymous HLS URL (PUBLIC_FUNK_HLS_URL) is shipped to the browser.

import { env } from "$env/dynamic/private";
import type { NowPlaying } from "./types";

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
  },
};
