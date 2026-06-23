<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageData, ActionData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let entries = $derived(data.schedule.entries);
</script>

<svelte:head>
  <title>FUNK demo — admin</title>
</svelte:head>

<section class="card">
  <div class="row">
    <h2>current programming</h2>
    <form method="POST" action="/admin/logout" use:enhance>
      <button type="submit" class="link">log out</button>
    </form>
  </div>

  {#if data.loadError}
    <p class="error">Could not load schedule: <code>{data.loadError}</code></p>
  {/if}

  {#if data.schedule.applied_at}
    <p class="status">
      applied at <code>{data.schedule.applied_at}</code>
    </p>
  {:else}
    <p class="status">no schedule applied yet</p>
  {/if}

  {#if entries.length > 0}
    <ol class="entries">
      {#each entries as entry (entry.audio_url + (entry.at ?? ""))}
        <li>
          <span class="title">{entry.title ?? "(untitled)"}</span>
          <code class="url">{entry.audio_url}</code>
          {#if entry.duration_seconds != null}
            <span class="dur">{entry.duration_seconds}s</span>
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p class="muted">The schedule is empty.</p>
  {/if}
</section>

<section class="card">
  <h2>set programming</h2>
  <p class="muted">
    PUT is a <strong>full replace</strong> — submitting this one-entry form
    replaces the entire schedule. (Multi-entry programming is a follow-up.)
  </p>

  {#if form?.error}
    <p class="error">{form.error}</p>
  {/if}

  <form method="POST" use:enhance>
    <label>
      <span>audio_url <em>(required)</em></span>
      <input
        name="audio_url"
        placeholder="file:///tmp/track.mp3 or https://…"
        value={form?.audio_url ?? ""}
        required
      />
    </label>
    <label>
      <span>title</span>
      <input name="title" placeholder="optional" value={form?.title ?? ""} />
    </label>
    <label>
      <span>duration_seconds</span>
      <input
        name="duration_seconds"
        type="number"
        min="1"
        step="1"
        placeholder="optional"
        value={form?.duration_seconds ?? ""}
      />
    </label>
    <button type="submit">apply programming</button>
  </form>
  <p class="status">
    routed server-side to <code>PUT /v1/radio/schedule</code> — the FUNK token
    stays on the server.
  </p>
</section>

<style>
  .card {
    background: #1a1a1f;
    border: 1px solid #2a2a30;
    border-radius: 8px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.6;
    margin: 0 0 0.75rem;
  }
  .entries {
    list-style: decimal;
    margin: 0.5rem 0 0;
    padding-left: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .entries li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  .title {
    font-weight: 600;
  }
  .url {
    opacity: 0.7;
  }
  .dur {
    font-size: 0.8rem;
    opacity: 0.6;
  }
  .muted {
    opacity: 0.6;
    font-size: 0.9rem;
    margin: 0 0 1rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 460px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  label span {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.6;
  }
  label em {
    font-style: normal;
    opacity: 0.7;
  }
  input {
    background: #0e0e10;
    border: 1px solid #2a2a30;
    border-radius: 6px;
    color: #f0f0f0;
    padding: 0.5rem 0.65rem;
    font-size: 0.95rem;
  }
  input:focus {
    outline: none;
    border-color: #4a4a55;
  }
  button {
    margin-top: 0.25rem;
    background: #2563eb;
    border: none;
    border-radius: 6px;
    color: #fff;
    padding: 0.55rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
  }
  button:hover {
    background: #1d4ed8;
  }
  button.link {
    background: none;
    color: #9aa4b2;
    padding: 0;
    margin: 0;
    font-weight: 500;
    text-decoration: underline;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
  }
  button.link:hover {
    color: #f0f0f0;
    background: none;
  }
  .status {
    font-size: 0.78rem;
    opacity: 0.5;
    margin: 0.75rem 0 0;
  }
  .error {
    color: #e23636;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
  }
</style>
