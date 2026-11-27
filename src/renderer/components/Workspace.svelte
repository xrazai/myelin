<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import type { NoteMetrics } from '../editor/note-metrics';
  import type { NoteProblems, NoteSaver } from '../editor/note-saver';
  import {
    chooseWidth,
    DEFAULT_WIDTHS,
    fitVisibleWidths,
    loadCollapsed,
    loadWidths,
    maxWidth,
    MIN_WIDTHS,
    resizeStored,
    saveCollapsed,
    saveWidths,
    toggleCollapsed,
    toggleFocusMode,
    type CollapsedPanels,
    type Side,
    type SideWidths,
  } from '../panel-layout';
  import { shortcutFor } from '../shortcuts';
  import { renameNote as coordinateRename } from '../rename-note';
  import { applyTabEvents, closeTab, cycleTab, moveTab, NO_TABS, openTab, renameTab, replaceTab, tabName, type Tabs as TabsState } from '../tabs-model';
  import { errorMessage } from '../error-message';
  import Editor from './Editor.svelte';
  import FileTree from './FileTree.svelte';
  import Splitter from './Splitter.svelte';
  import StatusBar from './StatusBar.svelte';
  import Tabs from './Tabs.svelte';

  let { vault }: { vault: VaultInfo } = $props();

  let tabs = $state.raw<TabsState>(NO_TABS);
  /** The pair being renamed: its tree batch arrives before the IPC result. */
  let pendingRename: { from: string; to: string } | null = null;

  // Marks the tabs of notes deleted outside the app. A pending rename's tree batch
  // must not mark the old tab deleted: its editor state is about to be rekeyed.
  $effect(() =>
    window.myelin.onVaultEvents((events) => {
      const visible = pendingRename
        ? events.filter(
            (event) =>
              !(
                (event.type === 'deleted' && event.path === pendingRename!.from) ||
                (event.type === 'created' && event.path === pendingRename!.to)
              ),
          )
        : events;
      tabs = applyTabEvents(tabs, visible);
    }),
  );

  let saver: NoteSaver | null = null;
  let problems = $state.raw<NoteProblems>(new Map());
  let metrics = $state.raw<NoteMetrics | null>(null);
  let renameError = $state('');

  /** Save, rename on disk, then rekey the open state without reopening the tab. */
  async function requestRename(from: string, to: string) {
    renameError = '';
    const notes = saver;
    if (!notes) return;
    pendingRename = { from, to };
    try {
      const result = await coordinateRename(
        window.myelin,
        {
          save: (path) => notes.save(path),
          move: (oldPath, newPath) => notes.rename(oldPath, newPath),
        },
        tabs,
        from,
        to,
      );
      if (result) tabs = result.tabs;
      else if (tabs.list.some((tab) => tab.path === from)) tabs = openTab(tabs, from);
    } catch (error) {
      renameError = `Could not rename the note. ${errorMessage(error)}`;
      tabs = openTab(tabs, from);
    } finally {
      pendingRename = null;
    }
  }

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
  let collapsed = $state.raw<CollapsedPanels>(untrack(() => loadCollapsed(localStorage, vault.id)));
  let beforeFocus = $state.raw<CollapsedPanels | null>(null);
  let resizing = $state(false);
  let windowWidth = $state(window.innerWidth);
  /** The screen as the last resize left it, until the window width changes. */
  let resized = $state.raw<{ shown: SideWidths; total: number } | null>(null);
  const shown = $derived(resized?.shown ?? fitVisibleWidths(widths, collapsed, windowWidth));
  const focusMode = $derived(collapsed.left && collapsed.right);

  function onwindowresize() {
    if (resized?.total !== window.innerWidth) resized = null;
  }

  const remember = () => {
    resizing = false;
    saveWidths(localStorage, vault.id, widths);
  };

  function toggleSide(side: Side) {
    beforeFocus = null;
    resized = null;
    collapsed = toggleCollapsed(collapsed, side);
    saveCollapsed(localStorage, vault.id, collapsed);
  }

  function toggleFocus() {
    resized = null;
    const next = toggleFocusMode(collapsed, beforeFocus);
    collapsed = next.collapsed;
    beforeFocus = next.beforeFocus;
    saveCollapsed(localStorage, vault.id, collapsed);
  }

  function resize(side: Side, width: number) {
    resizing = true;
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
  const toggleRightPanel = () => {
    if (collapsed.right) toggleSide('right');
    rightPanel = rightPanel === 'graph' ? 'brain' : 'graph';
  };

  function onkeydown(event: KeyboardEvent) {
    const shortcut = shortcutFor(event);
    if (!shortcut) return;
    // Also keeps `Ctrl+W` from reaching the window menu, which would close the window.
    event.preventDefault();
    if (shortcut === 'next-tab') tabs = cycleTab(tabs, 1);
    else if (shortcut === 'previous-tab') tabs = cycleTab(tabs, -1);
    else if (shortcut === 'toggle-right-panel') toggleRightPanel();
    else if (shortcut === 'toggle-focus-mode') toggleFocus();
    else if (shortcut === 'toggle-left-panel') toggleSide('left');
    else if (tabs.active === null) return;
    else if (shortcut === 'save') void saver?.save(tabs.active);
    else void requestClose(tabs.active);
  }
</script>

<svelte:window {onkeydown} {onbeforeunload} onblur={() => void saver?.saveAll()} onresize={onwindowresize} bind:innerWidth={windowWidth} />

<div
  class={['workspace', { resizing }]}
  style:grid-template-columns="{collapsed.left ? 0 : shown.left}px {collapsed.left ? 0 : 1}px minmax(0, 1fr) {collapsed.right ? 0 : 1}px {collapsed.right ? 0 : shown.right}px"
>
  <div class="tabs">
    <div class="bar-controls">
      <button
        type="button"
        class="icon-btn"
        aria-label="Toggle file tree"
        aria-pressed={!collapsed.left}
        title="Toggle file tree (Ctrl+Shift+B)"
        onclick={() => toggleSide('left')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
        </svg>
      </button>
    </div>

    <div class="tabs-strip">
      <Tabs
        {tabs}
        {problems}
        onactivate={(path) => (tabs = openTab(tabs, path))}
        onclose={requestClose}
        onmove={(path, to) => (tabs = moveTab(tabs, path, to))}
        onrename={requestRename}
      />
    </div>

    <div class="bar-controls">
      <button
        type="button"
        class="icon-btn"
        aria-label="Toggle focus mode"
        aria-pressed={focusMode}
        title="Focus mode (Ctrl+\)"
        onclick={toggleFocus}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label="Toggle right panel"
        aria-pressed={!collapsed.right}
        title="Toggle right panel"
        onclick={() => toggleSide('right')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <line x1="10" y1="2.5" x2="10" y2="13.5" />
        </svg>
      </button>
    </div>
  </div>

  <nav class={{ collapsed: collapsed.left }} inert={collapsed.left} aria-label="Files">
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
      <FileTree selected={tabs.active} onopen={(path) => (tabs = openTab(tabs, path))} onrename={requestRename} />
    </div>
  </nav>

  <div class={['splitter-slot', { collapsed: collapsed.left }]} inert={collapsed.left}>
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
  </div>

  <main>
    <Editor
      {vault}
      {tabs}
      {problems}
      {focusMode}
      onsaver={(next) => (saver = next)}
      onproblems={(next) => (problems = next)}
      ondiscard={(path) => (tabs = closeTab(tabs, path))}
      onfollow={follow}
      onmetrics={(next) => (metrics = next)}
      onfocusmode={toggleFocus}
    />
  </main>

  <div class={['splitter-slot', { collapsed: collapsed.right }]} inert={collapsed.right}>
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
  </div>

  <aside class={{ collapsed: collapsed.right }} inert={collapsed.right} aria-label={rightPanel === 'graph' ? 'Graph' : 'Brain panel'}>
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
    <StatusBar {metrics} hasActiveNote={tabs.active !== null} unsaved={[...problems.keys()].map(tabName)} />
  </div>
</div>

{#if renameError}
  <div class="rename-error" role="alert">
    <span>{renameError}</span>
    <button type="button" onclick={() => (renameError = '')}>Dismiss</button>
  </div>
{/if}

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
  .rename-error {
    position: fixed;
    right: 12px;
    bottom: 32px;
    z-index: 10;
    display: flex;
    gap: 12px;
    align-items: center;
    max-width: min(480px, 90vw);
    padding: 8px 12px;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
  }

  .rename-error button {
    flex: none;
    padding: 2px 8px;
    color: var(--text-muted);
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    cursor: pointer;
  }

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
    transition: grid-template-columns var(--t-panel) var(--ease-out);
  }

  .workspace.resizing {
    transition: none;
  }

  .tabs {
    grid-column: 1 / -1;
    display: flex;
    gap: 4px;
    align-items: center;
    min-width: 0;
    padding: 0 8px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--divider);
  }

  .tabs-strip {
    flex: 1;
    min-width: 0;
    height: 100%;
  }

  .bar-controls {
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .icon-btn[aria-pressed='true'] {
    color: var(--text);
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
    overflow: hidden;
    background: var(--bg-panel);
    transition: opacity var(--t-base) ease;
  }

  .splitter-slot {
    display: grid;
    min-width: 0;
    min-height: 0;
    transition: opacity var(--t-fast) ease;
  }

  nav.collapsed,
  aside.collapsed,
  .splitter-slot.collapsed {
    opacity: 0;
    pointer-events: none;
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
