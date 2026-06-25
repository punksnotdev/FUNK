<script lang="ts">
  import { enhance } from "$app/forms";
  import type { ActionData } from "./$types";

  let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
  <title>FUNK demo — admin login</title>
</svelte:head>

<section class="card">
  <h2>admin login</h2>
  <p class="muted">
    Operator sign-in. Credentials are validated server-side against the demo's
    env config — the password never reaches the browser.
  </p>

  {#if form?.error}
    <p class="error">{form.error}</p>
  {/if}

  <form method="POST" use:enhance>
    <label>
      <span>user</span>
      <input name="user" autocomplete="username" value={form?.user ?? ""} required />
    </label>
    <label>
      <span>password</span>
      <input name="pass" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit">sign in</button>
  </form>
</section>

<style>
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
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
  .muted {
    color: var(--dim);
    font-size: 0.88rem;
    margin: 0 0 1rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 320px;
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
    color: var(--dim);
    font-size: 0.72rem;
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
  input:focus {
    outline: none;
    border-color: var(--bright);
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
    border-radius: 0;
    transition:
      background 0.12s,
      color 0.12s;
  }
  button:hover {
    background: var(--bright);
    color: var(--bg);
  }
  .error {
    color: var(--bright);
    background: #1c1c1c;
    border-left: 2px solid var(--bright);
    padding: 0.4rem 0.7rem;
    font-size: 0.82rem;
    margin: 0 0 0.75rem;
  }
</style>
