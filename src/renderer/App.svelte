<script lang="ts">
  const title = 'Myelin';
</script>

<!-- Placeholder until the launcher and workspace exist: one sample of each theme role. -->
<div class="shell">
  <aside>
    <input type="search" placeholder="Search your vault" aria-label="Search your vault" />
    <p class="muted">0123456789 notes</p>
  </aside>
  <main class="prose">
    <h1>{title}</h1>
    <p>A vault of notes that <em>learns</em> from how you write and follow <a href="#top">links</a>.</p>
    <p class="muted"><code>[[Home]]</code></p>
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }

  aside {
    padding: 12px;
    background: var(--bg-panel);
    border-right: 1px solid var(--divider);
  }

  aside input {
    width: 100%;
  }

  main {
    padding: 32px 48px;
  }

  .muted {
    color: var(--text-muted);
  }

  code {
    font-size: 0.85em;
  }
</style>
