// Minimal liquidsoap telnet client. The protocol is line-based:
//   client writes "<command>\n"
//   server responds with zero or more lines, terminated by a literal "END\n"
//   (or a single line for short commands).
//
// We hold one connection per request — cheap, liquidsoap is local on the
// media plane and the command volume is low.

import { connect, type Socket } from "node:net";
import { env } from "./env";

async function sendCommand(command: string, timeoutMs = 2000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock: Socket = connect({
      host: env.LIQUIDSOAP_HOST,
      port: env.LIQUIDSOAP_TELNET_PORT,
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`liquidsoap telnet timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(command + "\n");
      sock.write("quit\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(buf.replace(/\r/g, ""));
    });
    sock.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function reloadMainPlaylist(): Promise<void> {
  // playlist sources reload when their file changes (reload_mode="watch" in
  // funk.liq) — but we poke them too in case the watcher missed an event.
  await sendCommand("main.reload");
}

export async function pushInterruptUrl(audioUrl: string): Promise<void> {
  // request.queue sources accept "interrupt.push <uri>". liquidsoap's queue
  // resolves the request and plays it; with track_sensitive=false on the
  // fallback above, it cuts in immediately.
  await sendCommand(`interrupt.push ${audioUrl}`);
}

export async function cancelInterrupt(): Promise<void> {
  // Drop whatever's currently being pulled from the interrupt source by
  // skipping its current track.
  await sendCommand("interrupt.skip");
}

interface NowPlayingState {
  source: string;
  metadata: Record<string, string>;
}

// Parse `key="value"` lines from a liquidsoap telnet metadata block into a map.
function parseMetadataLines(raw: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z0-9_]+)="(.*)"$/i);
    if (m && m[1] && m[2] !== undefined) metadata[m[1].toLowerCase()] = m[2];
  }
  return metadata;
}

export async function getNowPlayingMetadata(): Promise<NowPlayingState> {
  // Best-effort: report what's on air right now. There is no bare "metadata"
  // command in this config — the on-air *request* carries the richest data
  // (annotations from the schedule plus liquidsoap's own source tag), so we
  // resolve the active request id and read its metadata. The consumer just
  // wants enough to render "what's on right now."
  const onAirRaw = await sendCommand("request.on_air");
  // request.on_air returns whitespace-separated request ids; the last one is
  // the most recently put on air (the source currently feeding the output).
  const rids = onAirRaw.split(/\s+/).filter((t) => /^\d+$/.test(t));
  const rid = rids[rids.length - 1];
  if (!rid) {
    // Nothing on air (e.g. white-noise fallback). Report a stable shape.
    return { source: "unknown", metadata: {} };
  }

  const raw = await sendCommand(`request.metadata ${rid}`);
  const metadata = parseMetadataLines(raw);

  // Prefer the scheduled title annotation; fall back to liquidsoap's "song"
  // (derived from the m3u #EXTINF line) so a title shows even for legacy m3us.
  const title = metadata.title ?? metadata.song;
  if (title !== undefined) metadata.title = title;

  // funk_source is the marker writePlaylist() stamps on scheduled tracks.
  // Fall back to liquidsoap's own source tag (e.g. "main") and finally
  // "unknown" so the response always carries a sensible source.
  const source = metadata.funk_source ?? metadata.source ?? "unknown";
  return { source, metadata };
}

interface HarborStatus {
  live_connected: boolean;
  breaking_connected: boolean;
}

export async function getHarborStatus(): Promise<HarborStatus> {
  // In liquidsoap 2.2, input.harbor sources auto-assign IDs from the function
  // name: the first input.harbor becomes "input.harbor" and subsequent ones
  // become "input.harbor.2", "input.harbor.3", etc. The live source is the
  // first harbor defined in funk.liq; breaking is the second.
  const [liveRes, breakingRes] = await Promise.all([
    sendCommand("input.harbor.status").catch(() => ""),
    sendCommand("input.harbor.2.status").catch(() => ""),
  ]);
  return {
    live_connected: /connected/i.test(liveRes) && !/no source/i.test(liveRes),
    breaking_connected: /connected/i.test(breakingRes) && !/no source/i.test(breakingRes),
  };
}
