import { json } from "@sveltejs/kit";
import { funk } from "$lib/funk/client";
import type { RequestHandler } from "./$types";

// Server-side proxy for FUNK's now-playing.
//
// Why proxy instead of calling FUNK from the browser:
//   1. The FUNK_SERVICE_TOKEN stays server-side — never shipped to the client.
//   2. FUNK_RADIO_URL stays server-side too.
//   3. No CORS dance, and we can degrade gracefully when FUNK is unreachable.
//
// HLS audio is NOT proxied — it flows direct from FUNK's public, anonymous
// PUBLIC_FUNK_HLS_URL to the browser.
export const GET: RequestHandler = async () => {
  try {
    const data = await funk.radio.nowPlaying();
    return json(data, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return json(
      { source: "unknown", metadata: null, error: (err as Error).message },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
};
