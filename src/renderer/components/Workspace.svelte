<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import type { NoteProblems, NoteSaver } from '../editor/note-saver';
  import {
    chooseWidth,
    DEFAULT_WIDTHS,
    fitWidths,
    loadWidths,
    maxWidth,
    MIN_WIDTHS,
    resizeStored,
    saveWidths,
    type Side,
    type SideWidths,
  } from '../panel-layout';
  import { shortcutFor } from '../shortcuts';
  import { applyTabEvents, closeTab, cycleTab, moveTab, NO_TABS, openTab, replaceTab, tabName, type Tabs as TabsState } from '../tabs-model';
  import Editor from './Editor.svelte';
  import FileTree from './FileTree.svelte';
  import Splitter from './Splitter.svelte';
  import StatusBar from './StatusBar.svelte';
  import Tabs from './Tabs.svelte';

  let { vault }: { vault: VaultInfo } = $props();

  let tabs = $state.raw<TabsState>(NO_TABS);

  // Marks the tabs of notes deleted outside the app.
  $effect(() => window.myelin.onVaultEvents((events) => (tabs = applyTabEvents(tabs, events))));

  let saver: NoteSaver | null = null;
  let problems = $state.raw<NoteProblems>(new Map());

  /** A tab closes once nothing of the user's would be lost; otherwise it stays, showing why. */
  async function requestClose(path: string) {
    if ((await saver?.save(path)) !== false) tabs = closeTab(tabs, path);
    else if (tabs.list.some((tab) => tab.path === path)) tabs = openTab(tabs, path);
  }

  /** A followed link takes the tab of its note only once that note is safe to leave. */
  async function follow(path: string, source: string, newTab: boolean) {
    if (path === tabs.active) return;
    if (newTab || tabs.list.some((tab) => tab.path === path)) tabs = openTab(tabs, path);
    else if ((await saver?.save(source)) !== false) {
      tabs = tabs.active === source ? replaceTab(tabs, source, path) : openTab(tabs, path);
    }
  }

  // Quitting (or reloading) waits for the pending saves. If some text cannot be saved,
  // the user decides.
  let flushing = false;
  let abandon = false;
  /** Notes keeping the window open. */
  let unsavable = $state.raw<string[] | null>(null);
  let quitDialog = $state<HTMLDialogElement>();

  function onbeforeunload(event: BeforeUnloadEvent) {
    if (abandon || !saver || saver.unsaved().length === 0) return;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    const notes = saver;
    void notes.saveAll().then((saved) => {
      flushing = false;
      // Checked again on the way out: more may have been typed meanwhile.
      if (saved) return void window.myelin.resumeUnload();
      unsavable = notes.unsaved();
      const [first] = unsavable;
      if (first !== undefined) tabs = openTab(tabs, first);
    });
  }

  function leaveAnyway() {
    abandon = true;
    void window.myelin.resumeUnload();
  }

  $effect(() => {
    if (unsavable) quitDialog?.showModal();
  });

  /** What the user chose; `shown` is what fits the window now. */
  // The vault is fixed while the workspace is mounted.
  let widths = $state.raw(untrack(() => loadWidths(localStorage, vault.id)));
  let windowWidth = $state(window.innerWidth);
  /** The screen as the last resize left it, until the window width changes. */
  let resized = $state.raw<{ shown: SideWidths; total: number } | null>(null);
  const shown = $derived(resized?.shown ?? fitWidths(widths, windowWidth));

  function onwindowresize() {
    if (resized?.total !== window.innerWidth) resized = null;
  }

  const remember = () => saveWidths(localStorage, vault.id, widths);

  function resize(side: Side, width: number) {
    const next = resizeStored(widths, shown, side, width, windowWidth);
    widths = next.stored;
    resized = { shown: next.shown, total: windowWidth };
  }

  function reset(side: Side) {
    // The default is what is remembered, even where it does not fit now.
    resize(side, DEFAULT_WIDTHS[side]);
    widths = chooseWidth(widths, side, DEFAULT_WIDTHS[side], windowWidth);
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
    else if (tabs.active === null) return;
    else if (shortcut === 'save') void saver?.save(tabs.active);
    else void requestClose(tabs.active);
  }
</script>

<svelte:window {onkeydown} {onbeforeunload} onblur={() => void saver?.saveAll()} onresize={onwindowresize} bind:innerWidth={windowWidth} />

<div class="workspace" style:grid-template-columns="{shown.left}px 1px minmax(0, 1fr) 1px {shown.right}px">
  <div class="tabs">
    <Tabs
      {tabs}
      {problems}
      onactivate={(path) => (tabs = openTab(tabs, path))}
      onclose={requestClose}
      onmove={(path, to) => (tabs = moveTab(tabs, path, to))}
    />
  </div>

  <nav aria-label="Files">
    <header class="sidebar-header">
      <h1 title={vault.root}>
        <svg class="vault-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 19c4-1 8-5 14-14-9 6-13 10-14 14Z" />
          <path d="M9.5 14.5 15 9" />
          <circle cx="17.5" cy="6.5" r="2" fill="currentColor" stroke="none" />
        </svg>
        <span class="vault-name">{vault.name}</span>
      </h1>
    </header>
    <button
      type="button"
      class="quick-open"
      title="Jump to note (Ctrl+P)"
      onclick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="7.2" cy="7.2" r="4.5" />
        <path d="M10.8 10.8 14 14" stroke-linecap="round" />
      </svg>
      <span class="quick-open-label">Jump to note…</span>
      <kbd>Ctrl+P</kbd>
    </button>
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
    <Editor
      {vault}
      {tabs}
      {problems}
      onsaver={(next) => (saver = next)}
      onproblems={(next) => (problems = next)}
      ondiscard={(path) => (tabs = closeTab(tabs, path))}
      onfollow={follow}
    />
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
    <header class="right-header">
      <div class="segmented" data-mode={rightPanel} role="group" aria-label="Right panel view">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button
          type="button"
          class="seg-btn"
          aria-pressed={rightPanel === 'graph'}
          onclick={() => (rightPanel = 'graph')}
        >
          Graph
        </button>
        <button
          type="button"
          class="seg-btn"
          aria-pressed={rightPanel === 'brain'}
          onclick={() => (rightPanel = 'brain')}
        >
          Brain
        </button>
      </div>
      <kbd class="shortcut-hint" title="Switch between Graph and Brain panel (Ctrl+Shift+L)">Ctrl+Shift+L</kbd>
    </header>
    <!-- Placeholder: `@myelin/graph` or the Brain panel mounts here later. -->
    <p>{rightPanel === 'graph' ? 'The graph is not here yet.' : 'The Brain panel is not here yet.'}</p>
  </aside>

  <div class="status">
    <StatusBar {vault} unsaved={[...problems.keys()].map(tabName)} />
  </div>
</div>

{#if unsavable}
  <dialog bind:this={quitDialog} onclose={() => (unsavable = null)} aria-labelledby="unsaved-title">
    <h2 id="unsaved-title">Some notes are not saved</h2>
    <p>{unsavable.join(', ')}</p>
    <p>Quitting now loses the unsaved text.</p>
    <form method="dialog">
      <button type="submit">Keep editing</button>
      <button type="button" onclick={leaveAnyway}>Quit and lose it</button>
    </form>
  </dialog>
{/if}

<style>
  dialog {
    max-width: min(480px, 90vw);
    padding: 20px 24px;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 10px;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 50%);
  }

  dialog h2 {
    margin: 0;
    font-size: 16px;
  }

  dialog p {
    margin: 10px 0 0;
    overflow-wrap: anywhere;
  }

  dialog form {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  dialog button {
    padding: 4px 12px;
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    cursor: pointer;
  }

  dialog button:hover {
    border-color: var(--accent);
  }

  .workspace {
    display: grid;
    grid-template-rows: 38px minmax(0, 1fr) 26px;
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

  .sidebar-header {
    display: flex;
    flex: none;
    align-items: center;
    height: 40px;
    padding: 0 12px 0 14px;
  }

  .sidebar-header h1 {
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
    margin: 0;
    font-size: var(--font-size-ui);
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  .vault-mark {
    flex: none;
    color: var(--accent);
  }

  .vault-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-open {
    display: flex;
    flex: none;
    gap: 7px;
    align-items: center;
    height: 30px;
    margin: 0 10px 8px;
    padding: 0 9px;
    color: var(--text-muted);
    background: var(--bg-editor);
    border: 1px solid var(--divider);
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }

  .quick-open:hover {
    border-color: var(--accent-ring);
    color: var(--text);
  }

  .quick-open-label {
    flex: 1;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-open kbd {
    flex: none;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10.5px;
    color: var(--text-muted);
    background: var(--surface-hover);
    border: 1px solid var(--hairline);
  }

  .files {
    flex: 1;
    min-height: 0;
  }

  main {
    min-width: 0;
    min-height: 0;
  }

  .right-header {
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    padding: 0 12px;
  }

  .segmented {
    position: relative;
    display: inline-grid;
    grid-template-columns: 1fr 1fr;
    width: 148px;
    padding: 2px;
    background: var(--bg-editor);
    border: 1px solid var(--divider);
    border-radius: 7px;
  }

  .seg-thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc(50% - 2px);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
    border-radius: 5px;
    pointer-events: none;
    transition: transform var(--t-base) var(--ease-out);
  }

  .segmented[data-mode='brain'] .seg-thumb {
    transform: translateX(100%);
  }

  .seg-btn {
    position: relative;
    z-index: 1;
    height: 22px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    background: none;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
  }

  .seg-btn:hover {
    color: var(--text);
  }

  .seg-btn[aria-pressed='true'] {
    color: var(--accent);
  }

  .shortcut-hint {
    flex: none;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10.5px;
    color: var(--text-muted);
    background: var(--surface-hover);
    border: 1px solid var(--hairline);
  }

  aside p {
    margin: 0;
    padding: 6px 12px;
    color: var(--text-muted);
  }
</style>
