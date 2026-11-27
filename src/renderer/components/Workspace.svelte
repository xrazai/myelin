<script lang="ts">
  import type { VaultInfo } from '../../shared/ipc';

  let { vault }: { vault: VaultInfo } = $props();
</script>

<!-- Bare shell: the file tree, tabs, panels and status bar mount here later. -->
<main>
  <h1>{vault.name}</h1>
  <p>{vault.root}</p>
</main>

<style>
  main {
    min-height: 100vh;
    padding: 32px 48px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  p {
    margin: 4px 0 0;
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
</style>
