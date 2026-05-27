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

export async function getNowPlayingMetadata(): Promise<NowPlayingState> {
  // Best-effort: liquidsoap's "metadata" command returns the active source's
  // current metadata block. We don't try to parse exhaustively; the consumer
  // just wants enough to render "what's on right now."
  const raw = await sendCommand("metadata");
  const metadata: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z0-9_]+)="(.*)"$/i);
    if (m && m[1] && m[2] !== undefined) metadata[m[1].toLowerCase()] = m[2];
  }
  return { source: metadata.source ?? "unknown", metadata };
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
