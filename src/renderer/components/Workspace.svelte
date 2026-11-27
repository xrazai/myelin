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
      onrename={requestRename}
    />
  </div>

  <nav aria-label="Files">
    <h1 title={vault.root}>{vault.name}</h1>
    <div class="files">
      <FileTree selected={tabs.active} onopen={(path) => (tabs = openTab(tabs, path))} onrename={requestRename} />
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
    <StatusBar {vault} unsaved={[...problems.keys()].map(tabName)} />
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
