<script lang="ts">
  let { children } = $props();
</script>

<main>
  <header>
    <h1>FUNK</h1>
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
</style>
