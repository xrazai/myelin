<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import { DEFAULT_WIDTHS, fitWidths, loadWidths, maxWidth, MIN_WIDTHS, resizeSide, saveWidths, type Side } from '../panel-layout';
  import { shortcutFor } from '../shortcuts';
  import { applyTabEvents, closeTab, cycleTab, moveTab, NO_TABS, openTab, type Tabs as TabsState } from '../tabs-model';
  import Editor from './Editor.svelte';
  import FileTree from './FileTree.svelte';
  import Splitter from './Splitter.svelte';
  import StatusBar from './StatusBar.svelte';
  import Tabs from './Tabs.svelte';

  let { vault }: { vault: VaultInfo } = $props();

  let tabs = $state.raw<TabsState>(NO_TABS);

  // Marks the tabs of notes deleted outside the app.
  $effect(() => window.myelin.onVaultEvents((events) => (tabs = applyTabEvents(tabs, events))));

  /** What the user chose; `shown` is what fits the window now. */
  // The vault is fixed while the workspace is mounted.
  let widths = $state.raw(untrack(() => loadWidths(localStorage, vault.id)));
  let windowWidth = $state(window.innerWidth);
  const shown = $derived(fitWidths(widths, windowWidth));

  const remember = () => saveWidths(localStorage, vault.id, widths);

  function resize(side: Side, width: number) {
    widths = resizeSide(shown, side, width, windowWidth);
  }

  function reset(side: Side) {
    resize(side, DEFAULT_WIDTHS[side]);
    remember();
  }

  /** The graph and the Brain panel share the right column. */
  let rightPanel = $state<'graph' | 'brain'>('graph');
  const toggleRightPanel = () => (rightPanel = rightPanel === 'graph' ? 'brain' : 'graph');

  function onkeydown(event: KeyboardEvent) {
    const shortcut = shortcutFor(event);
    if (!shortcut) return;
    // Also keeps `Ctrl+W` from reaching the window menu, which would close the window.
    event.preventDefault();
    if (shortcut === 'next-tab') tabs = cycleTab(tabs, 1);
    else if (shortcut === 'previous-tab') tabs = cycleTab(tabs, -1);
    else if (shortcut === 'toggle-right-panel') toggleRightPanel();
    else if (tabs.active !== null) tabs = closeTab(tabs, tabs.active);
  }
</script>

<svelte:window {onkeydown} bind:innerWidth={windowWidth} />

<div class="workspace" style:grid-template-columns="{shown.left}px 1px minmax(0, 1fr) 1px {shown.right}px">
  <div class="tabs">
    <Tabs
      {tabs}
      onactivate={(path) => (tabs = openTab(tabs, path))}
      onclose={(path) => (tabs = closeTab(tabs, path))}
      onmove={(path, to) => (tabs = moveTab(tabs, path, to))}
    />
  </div>

  <nav aria-label="Files">
    <h1 title={vault.root}>{vault.name}</h1>
    <div class="files">
      <FileTree selected={tabs.active} onopen={(path) => (tabs = openTab(tabs, path))} />
    </div>
  </nav>

  <Splitter
    side="left"
    label="Resize the file tree"
    value={shown.left}
    min={MIN_WIDTHS.left}
    max={maxWidth(shown, 'left', windowWidth)}
    onresize={(width) => resize('left', width)}
    oncommit={remember}
    onreset={() => reset('left')}
  />

  <main>
    <Editor {vault} {tabs} />
  </main>

  <Splitter
    side="right"
    label="Resize the right column"
    value={shown.right}
    min={MIN_WIDTHS.right}
    max={maxWidth(shown, 'right', windowWidth)}
    onresize={(width) => resize('right', width)}
    oncommit={remember}
    onreset={() => reset('right')}
  />

  <aside aria-label={rightPanel === 'graph' ? 'Graph' : 'Brain panel'}>
    <header>
      <h2>{rightPanel === 'graph' ? 'Graph' : 'Brain panel'}</h2>
      <button type="button" title="Switch between graph and Brain panel (Ctrl+Shift+L)" onclick={toggleRightPanel}>
        {rightPanel === 'graph' ? 'Brain panel' : 'Graph'}
      </button>
    </header>
    <!-- Placeholder: `@myelin/graph` or the Brain panel mounts here later. -->
    <p>{rightPanel === 'graph' ? 'The graph is not here yet.' : 'The Brain panel is not here yet.'}</p>
  </aside>

  <div class="status">
    <StatusBar {vault} />
  </div>
</div>

<style>
  .workspace {
    display: grid;
    grid-template-rows: 35px minmax(0, 1fr) 24px;
    height: 100vh;
    overflow: hidden;
  }

  .tabs {
    grid-column: 1 / -1;
    min-width: 0;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--divider);
  }

  .status {
    grid-column: 1 / -1;
    min-width: 0;
  }

  nav,
  aside {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-panel);
  }

  h1,
  aside h2 {
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
    min-width: 0;
    min-height: 0;
  }

  aside header {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    padding-right: 8px;
  }

  aside header h2 {
    flex: 0 1 auto;
  }

  aside button {
    flex: none;
    padding: 3px 8px;
    color: var(--text-muted);
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    cursor: pointer;
  }

  aside button:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  aside p {
    margin: 0;
    padding: 4px 12px;
    color: var(--text-muted);
  }
</style>
