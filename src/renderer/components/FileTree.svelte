<script lang="ts">
  import { tick } from 'svelte';
  import type { TreeEntry } from '../../shared/ipc';
  import { errorMessage } from '../error-message';
  import { flatten, keyAction, pruneExpanded, scrollToShow, visibleRange, watchTree } from '../tree-model';

  /** `selected`: path of the open note. `onopen`: a note was clicked or chosen by keyboard. */
  let {
    selected,
    onopen,
    onrename,
  }: {
    selected: string | null;
    onopen: (path: string) => void;
    onrename: (from: string, to: string) => void;
  } = $props();

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
        tree = next;
        expanded = pruneExpanded(expanded, events);
      },
      error(reason) {
        error = `Could not list the notes. ${errorMessage(reason)}`;
      },
    }),
  );

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
    const name = renameText.trim();
    renaming = null;
    if (!name) return;
    const dir = from.slice(0, Math.max(0, from.lastIndexOf('/')));
    const to = dir ? `${dir}/${name}.md` : `${name}.md`;
    if (to !== from) onrename(from, to);
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
    const element = (event.target as Element).closest<HTMLElement>('[data-index]');
    const entry = element && rows[Number(element.dataset['index'])]?.entry;
    if (!entry || entry.kind !== 'note') return;
    event.preventDefault();
    cursor = entry.path;
    startRename(entry.path);
  }

  async function onkeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const action = keyAction(rows, cursorIndex, event.key, expanded);
    if (!action) return;
    event.preventDefault();
    if (action.type === 'move') {
      cursor = rows[action.index]!.entry.path;
    } else if (action.type === 'rename') {
      cursor = action.path;
      startRename(action.path);
    } else {
      cursor = action.path;
      if (action.type === 'toggle') toggle(action.path);
      else onopen(action.path);
    }
    await tick();
    if (list) list.scrollTop = scrollToShow(cursorIndex, list.scrollTop, list.clientHeight, ROW_HEIGHT);
  }
</script>

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
    {oncontextmenu}
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
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="rename"
                bind:this={input}
                bind:value={renameText}
                aria-label="Rename note"
                onclick={(event) => event.stopPropagation()}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    renaming = null;
                  }
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

<style>
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
