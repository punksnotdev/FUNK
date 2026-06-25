<script lang="ts">
  let { children } = $props();
</script>

<main>
  <header>
    <h1><span class="prompt">&gt;</span> FUNK<span class="cursor">_</span></h1>
    <p class="sub">// machine-facing radio · dev</p>
  </header>
  {@render children()}
</main>

<style>
  /* Monochrome / terminal palette — no colour, all signal carried by weight,
     borders, and inversion. Mono font stack goes well beyond Courier New;
     falls back to the platform mono if JetBrains Mono isn't installed. */
  :global(:root) {
    --bg: #0a0a0a;
    --panel: #101012;
    --fg: #cfcfcf;
    --bright: #f2f2f2;
    --dim: #767676;
    --line: #262628;
    --line-2: #3a3a3d;
    --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", "SF Mono",
      "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    font-family: var(--mono);
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: "liga" 0;
  }
  :global(a) {
    color: var(--bright);
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 2rem 1rem 4rem;
  }
  header {
    margin-bottom: 1.75rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }
  h1 {
    font-size: 1.55rem;
    margin: 0;
    letter-spacing: 0.16em;
    font-weight: 600;
    color: var(--bright);
  }
  .prompt {
    color: var(--dim);
    margin-right: 0.1em;
  }
  .cursor {
    display: inline-block;
    margin-left: 0.05em;
    color: var(--bright);
    animation: blink 1.1s steps(1) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .sub {
    margin: 0.45rem 0 0;
    font-size: 0.75rem;
    color: var(--dim);
    letter-spacing: 0.05em;
  }
</style>
