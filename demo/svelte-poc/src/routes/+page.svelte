<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Hls from "hls.js";
  import { PUBLIC_HLS_URL } from "$env/static/public";
  import { session, setSession } from "$lib/session.svelte";
  import { createInvitation, claimInvitation, uploadFile, fileUrl } from "$lib/api";

  let invitationInput = $state("");
  let adminToken = $state("");
  let inviteRole = $state<"admin" | "contributor" | "listener">("contributor");
  let inviteResult = $state<{ token: string; role: string } | null>(null);
  let uploadFileEl: HTMLInputElement | null = $state(null);
  let lastUpload = $state<{ key: string; size_bytes: number } | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  let videoEl: HTMLVideoElement | null = $state(null);
  let hls: Hls | null = null;
  let hlsState = $state<"idle" | "loading" | "playing" | "error">("idle");

  function attachHls(): void {
    if (!videoEl) return;
    hlsState = "loading";
    if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: false });
      hls.loadSource(PUBLIC_HLS_URL);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hlsState = "playing";
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) hlsState = "error";
      });
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = PUBLIC_HLS_URL;
      videoEl.addEventListener("loadedmetadata", () => (hlsState = "playing"));
      videoEl.addEventListener("error", () => (hlsState = "error"));
    } else {
      hlsState = "error";
    }
  }

  onMount(() => attachHls());
  onDestroy(() => hls?.destroy());

  async function handleClaim() {
    error = null;
    busy = "claim";
    try {
      const s = await claimInvitation(invitationInput.trim());
      setSession({ token: s.token, role: s.role, expires_at: s.expires_at });
      invitationInput = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = null;
    }
  }

  async function handleCreateInvite() {
    error = null;
    busy = "invite";
    try {
      inviteResult = await createInvitation(adminToken.trim(), inviteRole);
    } catch (e) {
      error = String(e);
    } finally {
      busy = null;
    }
  }

  async function handleUpload() {
    error = null;
    if (!session.current) return;
    const file = uploadFileEl?.files?.[0];
    if (!file) return;
    busy = "upload";
    try {
      const u = await uploadFile(session.current.token, file);
      lastUpload = { key: u.key, size_bytes: u.size_bytes };
      if (uploadFileEl) uploadFileEl.value = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = null;
    }
  }

  function handleLogout() {
    setSession(null);
    inviteResult = null;
    lastUpload = null;
  }
</script>

<section class="card">
  <h2>radio</h2>
  <video bind:this={videoEl} controls muted playsinline></video>
  <p class="status">stream: <code>{PUBLIC_HLS_URL}</code> &middot; {hlsState}</p>
</section>

<section class="card">
  <h2>session</h2>
  {#if session.current}
    <p>role: <strong>{session.current.role}</strong> &middot; expires {new Date(session.current.expires_at).toLocaleString()}</p>
    <button onclick={handleLogout}>log out</button>
  {:else}
    <p class="muted">anonymous — paste an invitation token to claim a session</p>
    <form onsubmit={(e) => { e.preventDefault(); handleClaim(); }}>
      <input type="text" placeholder="invitation token" bind:value={invitationInput} required />
      <button type="submit" disabled={busy === "claim"}>claim</button>
    </form>
  {/if}
</section>

{#if session.current?.role === "admin" || !session.current}
  <section class="card">
    <h2>create invitation (admin)</h2>
    <p class="muted">paste <code>ADMIN_BOOTSTRAP_TOKEN</code> from <code>infra/env/control.dev.env</code> to mint an invitation.</p>
    <form onsubmit={(e) => { e.preventDefault(); handleCreateInvite(); }}>
      <input type="password" placeholder="admin bootstrap token" bind:value={adminToken} required />
      <select bind:value={inviteRole}>
        <option value="contributor">contributor</option>
        <option value="admin">admin</option>
        <option value="listener">listener</option>
      </select>
      <button type="submit" disabled={busy === "invite"}>mint</button>
    </form>
    {#if inviteResult}
      <pre class="result">{inviteResult.role}: {inviteResult.token}</pre>
    {/if}
  </section>
{/if}

{#if session.current && session.current.role !== "listener"}
  <section class="card">
    <h2>upload</h2>
    <input type="file" bind:this={uploadFileEl} />
    <button onclick={handleUpload} disabled={busy === "upload"}>upload to FUNK storage</button>
    {#if lastUpload}
      <p class="result">
        stored: <code>{lastUpload.key}</code> ({lastUpload.size_bytes} bytes)<br />
        <a href={fileUrl(lastUpload.key)} target="_blank" rel="noopener noreferrer">download (presigned)</a>
      </p>
    {/if}
  </section>
{/if}

{#if error}
  <section class="card error">
    <strong>error</strong>
    <pre>{error}</pre>
  </section>
{/if}

<style>
  .card {
    background: #1a1a1f;
    border: 1px solid #2a2a30;
    border-radius: 8px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  .card.error {
    border-color: #b34;
    background: #1f0e12;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.6;
    margin: 0 0 0.75rem;
  }
  video {
    width: 100%;
    background: #000;
    border-radius: 4px;
  }
  .muted {
    opacity: 0.6;
    font-size: 0.9rem;
  }
  .status {
    font-size: 0.8rem;
    opacity: 0.5;
    margin: 0.5rem 0 0;
  }
  form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input[type="text"],
  input[type="password"] {
    flex: 1;
    min-width: 200px;
  }
  input, select, button {
    background: #0e0e10;
    border: 1px solid #3a3a40;
    color: inherit;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font: inherit;
  }
  button {
    background: #2a4a8a;
    border-color: #2a4a8a;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  pre.result, p.result {
    background: #0e0e10;
    padding: 0.75rem;
    border-radius: 4px;
    margin-top: 0.75rem;
    overflow-wrap: break-word;
    word-break: break-all;
    white-space: pre-wrap;
    font-size: 0.85rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
  }
</style>
