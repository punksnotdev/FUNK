<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageData, ActionData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let entries = $derived(data.schedule.entries);
  let fileName = $state("");

  function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    fileName = input.files?.[0]?.name ?? "";
  }
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
    <p class="status">applied at <code>{data.schedule.applied_at}</code></p>
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
          {#if entry.artist || entry.album || entry.year != null || entry.genre}
            <span class="tags">
              {[entry.artist, entry.album, entry.year, entry.genre]
                .filter((v) => v != null && v !== "")
                .join(" · ")}
            </span>
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

  <form method="POST" enctype="multipart/form-data" use:enhance>
    <fieldset class="source">
      <legend>track source</legend>
      <label class="file">
        <span>upload mp3</span>
        <input
          name="file"
          type="file"
          accept="audio/mpeg,audio/mp3,.mp3"
          onchange={onFileChange}
        />
        <span class="filehint">{fileName || "no file selected"}</span>
      </label>
      <div class="or"><span>or</span></div>
      <label>
        <span>audio_url</span>
        <input
          name="audio_url"
          placeholder="https://… (ignored if a file is chosen)"
          value={form?.audio_url ?? ""}
        />
      </label>
    </fieldset>

    <label>
      <span>title</span>
      <input name="title" placeholder="optional" value={form?.title ?? ""} />
    </label>
    <label>
      <span>artist</span>
      <input name="artist" placeholder="optional" value={form?.artist ?? ""} />
    </label>
    <label>
      <span>album</span>
      <input name="album" placeholder="optional" value={form?.album ?? ""} />
    </label>
    <label>
      <span>year</span>
      <input
        name="year"
        type="number"
        min="1"
        step="1"
        placeholder="optional"
        value={form?.year ?? ""}
      />
    </label>
    <label>
      <span>genre</span>
      <input name="genre" placeholder="optional" value={form?.genre ?? ""} />
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
    a file is uploaded to <code>POST /v1/storage/uploads</code> then scheduled via
    <code>PUT /v1/radio/schedule</code> — the FUNK token stays on the server.
  </p>
</section>

<style>
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
  .entries {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .entries li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    padding-left: 1rem;
    border-left: 2px solid var(--line-2);
  }
  .title {
    font-weight: 600;
    color: var(--bright);
  }
  .url {
    color: var(--dim);
    word-break: break-all;
  }
  .dur {
    font-size: 0.8rem;
    color: var(--dim);
  }
  .tags {
    flex-basis: 100%;
    font-size: 0.8rem;
    color: var(--dim);
  }
  .muted {
    color: var(--dim);
    font-size: 0.88rem;
    margin: 0 0 1rem;
  }
  strong {
    color: var(--bright);
    font-weight: 600;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 480px;
  }
  fieldset.source {
    border: 1px dashed var(--line-2);
    padding: 1rem 1rem 1.1rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  legend {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--dim);
    padding: 0 0.4rem;
  }
  .or {
    display: flex;
    align-items: center;
    text-align: center;
    color: var(--line-2);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--line);
  }
  .or span {
    padding: 0 0.6rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  label > span:first-child {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--dim);
    font-size: 0.72rem;
  }
  .filehint {
    color: var(--dim);
    font-size: 0.74rem;
  }
  input {
    background: var(--bg);
    border: 1px solid var(--line-2);
    color: var(--fg);
    padding: 0.5rem 0.65rem;
    font-family: var(--mono);
    font-size: 0.9rem;
    border-radius: 0;
  }
  input::placeholder {
    color: #4d4d4d;
  }
  input:focus {
    outline: none;
    border-color: var(--bright);
  }
  input[type="file"] {
    padding: 0.45rem;
    color: var(--dim);
    font-size: 0.78rem;
  }
  input[type="file"]::file-selector-button {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line-2);
    padding: 0.3rem 0.7rem;
    margin-right: 0.7rem;
    font-family: var(--mono);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  input[type="file"]::file-selector-button:hover {
    background: var(--fg);
    color: var(--bg);
  }
  button {
    margin-top: 0.25rem;
    background: transparent;
    border: 1px solid var(--bright);
    color: var(--bright);
    padding: 0.55rem 1.1rem;
    font-family: var(--mono);
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    align-self: flex-start;
    border-radius: 0;
    transition:
      background 0.12s,
      color 0.12s;
  }
  button:hover {
    background: var(--bright);
    color: var(--bg);
  }
  button.link {
    background: none;
    border: none;
    color: var(--dim);
    padding: 0;
    margin: 0;
    text-decoration: underline;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }
  button.link:hover {
    background: none;
    color: var(--bright);
  }
  .status {
    font-size: 0.74rem;
    color: var(--dim);
    margin: 0.75rem 0 0;
  }
  .error {
    color: var(--bright);
    background: #1c1c1c;
    border-left: 2px solid var(--bright);
    padding: 0.4rem 0.7rem;
    font-size: 0.82rem;
    margin: 0 0 0.75rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--fg);
  }
</style>
