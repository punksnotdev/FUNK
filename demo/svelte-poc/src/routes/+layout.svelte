<script lang="ts">
  let { children } = $props();
</script>

<main>
  <header>
    <h1>FUNK <span class="version">demo-0</span></h1>
    <p class="tagline">open-source infra for movement platforms</p>
  </header>
  {@render children()}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: #0e0e10;
    color: #f0f0f0;
    line-height: 1.5;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 2rem 1rem 4rem;
  }
  header {
    margin-bottom: 2rem;
  }
  h1 {
    font-size: 2rem;
    margin: 0 0 0.25rem;
    letter-spacing: 0.05em;
  }
  .version {
    font-size: 0.6em;
    opacity: 0.5;
    margin-left: 0.5em;
  }
  .tagline {
    margin: 0;
    opacity: 0.6;
    font-size: 0.9rem;
  }
</style>
