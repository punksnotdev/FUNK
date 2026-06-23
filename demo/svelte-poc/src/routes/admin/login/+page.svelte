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
    background: #1a1a1f;
    border: 1px solid #2a2a30;
    border-radius: 8px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.6;
    margin: 0 0 0.75rem;
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
    opacity: 0.6;
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
  }
  button:hover {
    background: #1d4ed8;
  }
  .error {
    color: #e23636;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
</style>
