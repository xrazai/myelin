<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { TreeEntry } from '../../shared/ipc';
  import { errorMessage } from '../error-message';
  import { foldersAbove, menuItems, newItem, targetFolder, type ItemKind, type MenuItem } from '../new-item';
  import { renamedPath } from '../rename-note';
  import { cursorAfter, flatten, keyAction, pruneExpanded, scrollToShow, visibleRange, watchTree } from '../tree-model';
  import TreeMenu from './TreeMenu.svelte';

  /** `selected`: path of the open note. `onopen`: a note was clicked, chosen or created. */
  let {
    selected,
    onopen,
    onrename,
    hasTab,
    ondelete,
  }: {
    selected: string | null;
    onopen: (path: string) => void;
    onrename: (from: string, to: string) => void;
    /** A note with no file but a tab was deleted: its tab may hold its text. */
    hasTab: (path: string) => boolean;
    ondelete: (target: { path: string; kind: TreeEntry['kind'] }) => void;
  } = $props();

  export function focus() {
    list?.focus();
    void scrollToCursor();
  }

  /** Fixed, so only the rows in view need to be in the DOM. */
  const ROW_HEIGHT = 28;
  const INDENT = 14;
  const OVERSCAN = 10;

  // Raw state: the model replaces these, and a deep proxy over a whole vault is slow.
  let tree = $state.raw<TreeEntry[] | null>(null);
  let expanded = $state.raw<ReadonlySet<string>>(new Set());
  /** Path under the keyboard cursor. */
  let cursor = $state.raw<string | null>(null);
  let error = $state('');
  /** Path currently being renamed, and the text in the inline input. */
  let renaming = $state.raw<string | null>(null);
  let renameText = $state('');
  let input = $state<HTMLInputElement>();

  /** The item being named, and where it goes (`''`: the root). */
  let creating = $state.raw<{ kind: ItemKind; folder: string } | null>(null);
  let createText = $state('');
  /** Why the last attempt failed, until the name changes. */
  let failure = $state('');
  let submitting = false;
  let createInput = $state<HTMLInputElement>();
  /** The context menu: where it is and what it is about (`null`: no entry). */
  let menu = $state.raw<{ x: number; y: number; entry: TreeEntry | null } | null>(null);

  const item = $derived(creating && newItem(tree ?? [], creating.folder, creating.kind, createText));
  const refusal = $derived(failure || item?.problem || '');

  let list = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewHeight = $state(0);

  const rows = $derived(flatten(tree ?? [], expanded));
  // A cursor whose row is gone (collapsed or deleted) falls back to the first row.
  const cursorIndex = $derived(Math.max(0, rows.findIndex((row) => row.entry.path === cursor)));
  const range = $derived(visibleRange(scrollTop, viewHeight, ROW_HEIGHT, rows.length, OVERSCAN));
  const cursorRendered = $derived(cursorIndex >= range.start && cursorIndex < range.end);

  $effect(() =>
    watchTree(window.myelin, {
      tree(next, events) {
        // Not tracked: this effect subscribes once.
        const before = untrack(() => rows);
        tree = next;
        expanded = pruneExpanded(expanded, events);
        untrack(() => {
          const moved = cursorAfter(before, cursor, rows);
          if (moved === cursor) return;
          cursor = moved;
          void scrollToCursor();
        });
      },
      error(reason) {
        error = `Could not list the notes. ${errorMessage(reason)}`;
      },
    }),
  );

  /** Asks for the name of a new note or folder inside `folder`. */
  export async function startCreate(kind: ItemKind, folder = '') {
    menu = null;
    creating = { kind, folder };
    createText = '';
    failure = '';
    // Focus after the input is in the DOM.
    await tick();
    createInput?.focus();
  }

  function cancelCreate() {
    creating = null;
    failure = '';
  }

  function reveal(path: string) {
    expanded = new Set([...expanded, ...foldersAbove(path)]);
    cursor = path;
  }

  async function scrollToCursor() {
    await tick();
    if (list) list.scrollTop = scrollToShow(cursorIndex, list.scrollTop, list.clientHeight, ROW_HEIGHT);
  }

  async function submitCreate() {
    const asked = creating;
    if (!asked || !item || item.problem !== null || submitting) return;
    const { path } = item;
    if (asked.kind === 'note' && hasTab(path)) {
      // Shown, not written over. If it is the active tab already, nothing else takes the focus.
      creating = null;
      list?.focus();
      onopen(path);
      return;
    }
    submitting = true;
    try {
      if (asked.kind === 'folder') await window.myelin.createFolder(path);
      else if ((await window.myelin.writeNote(path, '', null)).status === 'conflict') {
        failure = `a note already exists at ${path}`;
        return;
      }
    } catch (error) {
      failure = errorMessage(error);
      return;
    } finally {
      submitting = false;
    }
    // Cancelled, or another name asked for, while this one was written.
    const current = creating === asked;
    if (current) creating = null;
    reveal(path);
    await scrollToCursor();
    if (!current) return;
    // With the input gone nothing has the focus: the editor of the new note takes it.
    if (asked.kind === 'note') onopen(path);
    else list?.focus();
  }

  function toggle(path: string) {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    expanded = next;
  }

  function startRename(path: string) {
    renaming = path;
    renameText = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
    // Focus after the input is in the DOM.
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  }

  function commitRename() {
    const from = renaming;
    if (!from) return;
    renaming = null;
    const to = renamedPath(from, renameText);
    if (to) onrename(from, to);
  }

  function onclick(event: MouseEvent) {
    const element = (event.target as Element).closest<HTMLElement>('[data-index]');
    const entry = element && rows[Number(element.dataset['index'])]?.entry;
    if (!entry) return;
    cursor = entry.path;
    if (entry.kind === 'folder') toggle(entry.path);
    else onopen(entry.path);
  }

  function oncontextmenu(event: MouseEvent) {
    // The inputs keep their own menu.
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    const element = (event.target as Element).closest<HTMLElement>('[data-index]');
    const entry = (element && rows[Number(element.dataset['index'])]?.entry) || null;
    if (entry) cursor = entry.path;
    menu = { x: event.clientX, y: event.clientY, entry };
  }

  /** The menu of the row under the keyboard cursor, next to it. */
  async function openCursorMenu() {
    await scrollToCursor();
    const entry = rows[cursorIndex]?.entry ?? null;
    const box = (document.getElementById(`tree-row-${cursorIndex}`) ?? list)?.getBoundingClientRect();
    if (entry) cursor = entry.path;
    menu = { x: (box?.left ?? 0) + 24, y: box?.bottom ?? 0, entry };
  }

  function pick(id: MenuItem['id']) {
    const entry = menu?.entry ?? null;
    menu = null;
    if (id === 'delete') {
      // The dialog gives the focus back to what has it when it opens.
      list?.focus();
      if (entry) ondelete({ path: entry.path, kind: entry.kind });
    } else if (id === 'rename') {
      if (entry) startRename(entry.path);
    } else {
      void startCreate(id === 'new-note' ? 'note' : 'folder', targetFolder(entry));
    }
  }

  function closeMenu(dismissed: boolean) {
    menu = null;
    if (dismissed) list?.focus();
  }

  async function onkeydown(event: KeyboardEvent) {
    // `preventDefault` keeps the key from also raising a `contextmenu` event.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (event.target !== list) return;
      event.preventDefault();
      await openCursorMenu();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const action = keyAction(rows, cursorIndex, event.key, expanded);
    if (!action) return;
    event.preventDefault();
    if (action.type === 'move') {
      cursor = rows[action.index]!.entry.path;
    } else if (action.type === 'delete') {
      // Only from the tree itself: in a field, `Delete` edits text.
      const entry = rows[cursorIndex]?.entry;
      if (event.target === list && entry) {
        cursor = entry.path;
        ondelete({ path: entry.path, kind: entry.kind });
      }
    } else if (action.type === 'rename') {
      cursor = action.path;
      startRename(action.path);
    } else {
      cursor = action.path;
      if (action.type === 'toggle') toggle(action.path);
      else onopen(action.path);
    }
    await scrollToCursor();
  }
</script>

<!-- Right click on any blank part opens the menu of the root. -->
<div class="file-tree" role="presentation" {oncontextmenu}>
<div class="actions">
  <button type="button" aria-label="New note" title="New note (Ctrl+N)" onclick={() => startCreate('note')}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M12.5 1.8v4.4M10.3 4h4.4" />
    </svg>
  </button>
  <button type="button" aria-label="New folder" title="New folder" onclick={() => startCreate('folder')}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 13H3.5A1.5 1.5 0 0 1 2 11.500v-7A1.5 1.5 0 0 1 3.500 3H6l1.500 2h5A1.500 1.500 0 0 1 14 6.500V8" />
      <path d="M12 9.800v4.4M9.800 12h4.4" />
    </svg>
  </button>
</div>

{#if creating}
  <div class="create">
    <label for="new-item-name">New {creating.kind} in {creating.folder || 'the vault root'}</label>
    <input
      id="new-item-name"
      bind:this={createInput}
      bind:value={createText}
      autocomplete="off"
      spellcheck="false"
      aria-invalid={refusal !== ''}
      aria-describedby={refusal ? 'new-item-problem' : undefined}
      oninput={() => (failure = '')}
      onkeydown={(event) => {
        if (event.isComposing) return;
        // Shortcuts still reach the window.
        if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          void submitCreate();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelCreate();
          void tick().then(() => list?.focus());
        }
      }}
      onblur={() => {
        // Leaving the window keeps it; moving elsewhere in the app gives it up.
        if (document.hasFocus() && !submitting) cancelCreate();
      }}
    />
    {#if refusal}
      <p id="new-item-problem" role="alert">{refusal}</p>
    {/if}
  </div>
{/if}

<div class="body">
{#if error}
  <p class="message" role="alert">{error}</p>
{:else if !tree}
  <p class="message">Loading notes…</p>
{:else if tree.length === 0}
  <p class="message">No notes yet.</p>
{:else}
  <!-- Focus stays on the container (`aria-activedescendant`): rows leave the DOM on scroll. -->
  <div
    class="tree"
    role="tree"
    aria-label="Notes"
    aria-activedescendant={cursorRendered ? `tree-row-${cursorIndex}` : undefined}
    tabindex="0"
    bind:this={list}
    bind:clientHeight={viewHeight}
    onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
    {onclick}
    {onkeydown}
  >
    <div class="sizer" role="none" style:height="{rows.length * ROW_HEIGHT}px">
      <div class="window" role="none" style:transform="translateY({range.start * ROW_HEIGHT}px)">
        {#each rows.slice(range.start, range.end) as row, offset (`${row.entry.kind}:${row.entry.path}`)}
          {@const index = range.start + offset}
          {@const open = row.entry.kind === 'folder' && expanded.has(row.entry.path)}
          <div
            id="tree-row-{index}"
            class={['row', row.entry.kind, { open, cursor: index === cursorIndex }]}
            role="treeitem"
            aria-level={row.level}
            aria-posinset={row.position}
            aria-setsize={row.siblings}
            aria-expanded={row.entry.kind === 'folder' ? open : undefined}
            aria-selected={row.entry.path === selected}
            data-index={index}
            title={row.entry.name}
            style:height="{ROW_HEIGHT}px"
            style:padding-left="{(row.level - 1) * INDENT + 8}px"
            style:--guides="{Math.max(0, row.level - 1) * INDENT}px"
          >
            {#if row.entry.kind === 'folder'}
              <svg class="glyph chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M4.5 2.5 8 6l-3.5 3.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {:else}
              <svg class="glyph note-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                <rect x="2" y="1.5" width="8" height="9" rx="1.5" />
                <path d="M4 4.5h4M4 7h2.8" stroke-linecap="round" />
              </svg>
            {/if}
            {#if renaming === row.entry.path}
              <input
                class="rename"
                bind:this={input}
                bind:value={renameText}
                aria-label="Rename note"
                onclick={(event) => event.stopPropagation()}
                onkeydown={(event) => {
                  // The tree would take space, arrows and Enter. Shortcuts still reach the window.
                  if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
                  if (event.key !== 'Enter' && event.key !== 'Escape') return;
                  event.preventDefault();
                  if (event.key === 'Enter') commitRename();
                  else renaming = null;
                  list?.focus();
                }}
                onblur={commitRename}
              />
            {:else}
              <span class="name">{row.entry.name}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
</div>
</div>

{#if menu}
  <TreeMenu items={menuItems(menu.entry)} x={menu.x} y={menu.y} onpick={pick} onclose={closeMenu} />
{/if}

<style>
  .file-tree {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .body {
    flex: 1;
    min-height: 0;
  }

  .actions {
    display: flex;
    flex: none;
    gap: 2px;
    justify-content: flex-end;
    padding: 0 10px 4px;
  }

  .actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--text-muted);
    background: none;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  .actions button:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  /* Over the rows, never pushing them: it closes on blur, in the middle of a click. */
  .create {
    position: absolute;
    top: 28px;
    right: 0;
    left: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 10px 8px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--divider);
  }

  .create label {
    overflow: hidden;
    color: var(--text-muted);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .create input {
    min-width: 0;
    padding: 4px 8px;
    color: var(--text);
    background: var(--bg-editor);
    border: 1px solid var(--divider);
    border-radius: 6px;
    font: inherit;
    font-size: 12.8px;
  }

  .create input:focus {
    border-color: var(--accent);
    outline: 1px solid transparent;
  }

  .create p {
    margin: 0;
    color: var(--text-muted);
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }

  .tree {
    --guide-color: var(--divider);
    height: 100%;
    padding: 2px 0 12px;
    overflow-x: hidden;
    overflow-y: auto;
    overflow-anchor: none;
  }

  .tree:hover {
    --guide-color: color-mix(in srgb, var(--accent) 24%, var(--divider));
  }

  .tree:focus-visible {
    outline-offset: -1px;
  }

  .sizer {
    overflow: hidden;
  }

  .window {
    padding: 0 6px;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    padding-right: 8px;
    border-radius: 6px;
    font-size: 12.8px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--t-fast) ease,
      color var(--t-fast) ease;
  }

  /* Vertical indentation guides aligned under parent folder chevrons (O(1) DOM cost). */
  .row::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 14px;
    width: var(--guides, 0px);
    background-image: repeating-linear-gradient(
      to right,
      var(--guide-color) 0 1px,
      transparent 1px 14px
    );
    pointer-events: none;
  }

  .row.folder {
    font-weight: 500;
    color: var(--text-muted);
  }

  .row.note {
    color: color-mix(in srgb, var(--text) 86%, var(--text-muted));
  }

  .row:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .row[aria-selected='true'] {
    background: var(--surface-active);
    color: var(--accent);
    font-weight: 500;
  }

  /* Keyboard focus stays instant: zero transition on outline. */
  .tree:focus-visible .cursor {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .glyph {
    flex: none;
    width: 12px;
    height: 12px;
  }

  .chevron {
    color: var(--text-muted);
    transition:
      transform 140ms var(--ease-out),
      color var(--t-fast) ease;
  }

  .folder.open .chevron {
    transform: rotate(90deg);
  }

  .folder:hover .chevron {
    color: var(--text);
  }

  .note-icon {
    opacity: 0.42;
    transition: opacity var(--t-fast) ease;
  }

  .row.note:hover .note-icon {
    opacity: 0.72;
  }

  .row[aria-selected='true'] .note-icon {
    opacity: 0.95;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rename {
    flex: 1;
    min-width: 0;
    padding: 1px 4px;
    color: var(--text);
    background: var(--bg-editor);
    border: 1px solid var(--accent);
    border-radius: 3px;
    font: inherit;
  }

  .message {
    margin: 0;
    padding: 8px 14px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
    user-select: text;
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>
