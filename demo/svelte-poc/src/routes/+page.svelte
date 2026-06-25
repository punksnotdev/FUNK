<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { PUBLIC_FUNK_HLS_URL } from "$env/static/public";
  import type { NowPlaying } from "$lib/funk/types";

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

  // Human-interesting track fields to surface from FUNK's free-form metadata,
  // in display order — one metadata key each, so we show artist/year/etc. and
  // skip the noisy technical tags. `title` is shown on its own above. These keys
  // match the tags the /admin page attaches to a schedule entry.
  const DISPLAY_FIELDS: { label: string; key: string }[] = [
    { label: "artist", key: "artist" },
    { label: "album", key: "album" },
    { label: "year", key: "year" },
    { label: "genre", key: "genre" },
  ];

  let metaEntries = $derived.by((): [string, string][] => {
    const m = nowPlaying?.metadata;
    if (!m) return [];
    const out: [string, string][] = [];
    for (const { label, key } of DISPLAY_FIELDS) {
      const value = m[key];
      if (typeof value === "string" && value.trim() !== "") out.push([label, value]);
      else if (typeof value === "number") out.push([label, String(value)]);
    }
    return out;
  });

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
  <audio bind:this={audioEl} controls preload="none"></audio>
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
    {#if nowPlaying.source === "live" || nowPlaying.source === "breaking"}
      <p class="src-tag">[ {nowPlaying.source} ]</p>
    {/if}
    {#if title}
      <p class="title">{title}</p>
    {:else}
      <p class="muted">No title in metadata.</p>
    {/if}
    {#if metaEntries.length > 0}
      <dl class="meta">
        {#each metaEntries as [key, value] (key)}
          <dt>{key}</dt>
          <dd>{value}</dd>
        {/each}
      </dl>
    {/if}
  {:else if nowPlayingError}
    <p class="muted">Now-playing unavailable: <code>{nowPlayingError}</code></p>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</section>

<style>
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
    transition: border-color 0.2s;
  }
  /* Live / breaking states are signalled monochromatically: a brighter solid
     border for live, a dashed border for breaking — no colour. */
  .now-playing.live {
    border-color: var(--bright);
  }
  .now-playing.breaking {
    border-style: dashed;
    border-color: var(--bright);
  }
  h2 {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--dim);
    margin: 0 0 0.75rem;
  }
  h2::before {
    content: "// ";
    color: var(--line-2);
  }
  audio {
    width: 100%;
    filter: grayscale(1) contrast(1.05);
  }
  .src-tag {
    margin: 0 0 0.4rem;
    font-size: 0.72rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--bright);
  }
  .title {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 700;
    color: var(--bright);
  }
  .meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.85rem;
    margin: 0.85rem 0 0;
  }
  .meta dt {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--dim);
    align-self: center;
  }
  .meta dt::before {
    content: "› ";
    color: var(--line-2);
  }
  .meta dd {
    margin: 0;
    font-size: 0.9rem;
    color: var(--fg);
  }
  .muted {
    color: var(--dim);
    font-size: 0.88rem;
  }
  .error {
    color: var(--bright);
    background: #1c1c1c;
    border-left: 2px solid var(--bright);
    padding: 0.4rem 0.7rem;
    font-size: 0.82rem;
    margin-top: 0.5rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--fg);
  }
</style>
