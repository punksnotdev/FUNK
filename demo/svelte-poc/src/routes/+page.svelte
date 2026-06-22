<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { PUBLIC_FUNK_HLS_URL } from "$env/static/public";
  import type { NowPlaying, NowPlayingSource } from "$lib/funk/types";

  let audioEl: HTMLAudioElement | null = $state(null);
  let nowPlaying: NowPlaying | null = $state(null);
  let streamError: string | null = $state(null);
  let nowPlayingError: string | null = $state(null);

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let hlsInstance: { destroy: () => void } | null = null;

  // Pull a human-readable title out of FUNK's free-form metadata if present.
  let title = $derived.by((): string | null => {
    const t = nowPlaying?.metadata?.title;
    return typeof t === "string" ? t : null;
  });

  function sourceLabel(source: NowPlayingSource): string {
    if (source === "live") return "Live broadcast";
    if (source === "breaking") return "Breaking-news interrupt";
    if (source === "schedule") return "Scheduled programming";
    return source; // unknown / future source value
  }

  async function fetchNowPlaying() {
    try {
      const res = await fetch("/api/now-playing");
      const data = (await res.json()) as NowPlaying & { error?: string };
      if (data.error) {
        nowPlayingError = data.error;
        nowPlaying = null;
      } else {
        nowPlayingError = null;
        nowPlaying = data;
      }
    } catch (err) {
      nowPlayingError = (err as Error).message;
      nowPlaying = null;
    }
  }

  async function attachHls() {
    if (!audioEl) return;
    // Safari + iOS play HLS natively; everywhere else needs hls.js.
    if (audioEl.canPlayType("application/vnd.apple.mpegurl")) {
      audioEl.src = PUBLIC_FUNK_HLS_URL;
      return;
    }
    const Hls = (await import("hls.js")).default;
    if (!Hls.isSupported()) {
      streamError = "HLS is not supported in this browser.";
      return;
    }
    const hls = new Hls();
    hls.loadSource(PUBLIC_FUNK_HLS_URL);
    hls.attachMedia(audioEl);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) streamError = `Stream error: ${data.type} / ${data.details}`;
    });
    hlsInstance = hls;
  }

  onMount(() => {
    fetchNowPlaying();
    pollInterval = setInterval(fetchNowPlaying, 10_000);
    attachHls();
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
    if (hlsInstance) hlsInstance.destroy();
  });
</script>

<svelte:head>
  <title>FUNK demo — listen</title>
</svelte:head>

<section class="card">
  <h2>radio</h2>
  <audio bind:this={audioEl} controls preload="none"></audio>
  <p class="status">
    stream: <code>{PUBLIC_FUNK_HLS_URL}</code> (anonymous — no token)
  </p>
  {#if streamError}
    <p class="error">{streamError}</p>
  {/if}
</section>

<section
  class="card now-playing"
  class:live={nowPlaying?.source === "live"}
  class:breaking={nowPlaying?.source === "breaking"}
>
  <h2>now playing</h2>
  {#if nowPlaying}
    <p class="source">{sourceLabel(nowPlaying.source)}</p>
    {#if title}
      <p class="title">{title}</p>
    {:else}
      <p class="muted">No title in metadata.</p>
    {/if}
  {:else if nowPlayingError}
    <p class="muted">Now-playing unavailable: <code>{nowPlayingError}</code></p>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
  <p class="status">via server proxy <code>/api/now-playing</code> (token stays server-side)</p>
</section>

<style>
  .card {
    background: #1a1a1f;
    border: 1px solid #2a2a30;
    border-radius: 8px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
    transition: border-color 0.2s, background 0.2s;
  }
  .now-playing.live {
    border-color: #e23636;
    background: #1c0e0e;
  }
  .now-playing.breaking {
    border-color: #e2a236;
    background: #1c1407;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.6;
    margin: 0 0 0.75rem;
  }
  audio {
    width: 100%;
  }
  .source {
    margin: 0 0 0.25rem;
    font-weight: 600;
  }
  .title {
    margin: 0;
    font-size: 1.1rem;
  }
  .muted {
    opacity: 0.6;
    font-size: 0.9rem;
  }
  .status {
    font-size: 0.78rem;
    opacity: 0.5;
    margin: 0.75rem 0 0;
  }
  .error {
    color: #e23636;
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
  }
</style>
