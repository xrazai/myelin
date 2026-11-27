<script lang="ts">
  import type { VaultInfo } from '../../shared/ipc';
  import FileTree from './FileTree.svelte';

  let { vault }: { vault: VaultInfo } = $props();

  /** Path of the open note. */
  let openPath = $state<string | null>(null);
  const openName = $derived(openPath?.split('/').at(-1)?.replace(/\.md$/i, ''));
</script>

<!-- Tabs, resizable panels and the status bar mount here later. -->
<div class="workspace">
  <nav aria-label="Files">
    <h1 title={vault.root}>{vault.name}</h1>
    <div class="files">
      <FileTree selected={openPath} onopen={(path) => (openPath = path)} />
    </div>
  </nav>
  <main>
    {#if openPath}
      <!-- Placeholder until the editor exists: the note is not read yet. -->
      <h2 class="prose">{openName}</h2>
      <p class="path">{openPath}</p>
      <p>The editor is not here yet.</p>
    {:else}
      <p>Select a note in the file tree.</p>
      <p class="path">{vault.root}</p>
    {/if}
  </main>
</div>

<style>
  .workspace {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100vh;
  }

  nav {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-panel);
    border-right: 1px solid var(--divider);
  }

  h1 {
    flex: none;
    margin: 0;
    padding: 12px;
    overflow: hidden;
    font-size: var(--font-size-ui);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .files {
    flex: 1;
    min-height: 0;
  }

  main {
    overflow: auto;
    padding: 32px 48px;
  }

  h2 {
    margin: 0;
    font-size: 28px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  p {
    margin: 8px 0 0;
    color: var(--text-muted);
  }

  .path {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
