<script lang="ts">
  import { tick } from 'svelte';
  import type { TreeEntry } from '../../shared/ipc';
  import { errorMessage } from '../error-message';
  import { flatten, keyAction, pruneExpanded, scrollToShow, visibleRange, watchTree } from '../tree-model';

  /** `selected`: path of the open note. `onopen`: a note was clicked or chosen by keyboard. */
  let { selected, onopen }: { selected: string | null; onopen: (path: string) => void } = $props();

  /** Fixed, so only the rows in view need to be in the DOM. */
  const ROW_HEIGHT = 24;
  const OVERSCAN = 10;

  // Raw state: the model replaces these, and a deep proxy over a whole vault is slow.
  let tree = $state.raw<TreeEntry[] | null>(null);
  let expanded = $state.raw<ReadonlySet<string>>(new Set());
  /** Path under the keyboard cursor. */
  let cursor = $state.raw<string | null>(null);
  let error = $state('');

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

  function onclick(event: MouseEvent) {
    const element = (event.target as Element).closest<HTMLElement>('[data-index]');
    const entry = element && rows[Number(element.dataset['index'])]?.entry;
    if (!entry) return;
    cursor = entry.path;
    if (entry.kind === 'folder') toggle(entry.path);
    else onopen(entry.path);
  }

  async function onkeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const action = keyAction(rows, cursorIndex, event.key, expanded);
    if (!action) return;
    event.preventDefault();
    if (action.type === 'move') {
      cursor = rows[action.index]!.entry.path;
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
    {onkeydown}
  >
    <div class="sizer" role="none" style:height="{rows.length * ROW_HEIGHT}px">
      <div role="none" style:transform="translateY({range.start * ROW_HEIGHT}px)">
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
            style:padding-left="{(row.level - 1) * 14 + 8}px"
          >
            <span class="chevron" aria-hidden="true"></span>
            <span class="name">{row.entry.name}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .tree {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    overflow-anchor: none;
  }

  .tree:focus-visible {
    outline-offset: -1px;
  }

  .sizer {
    overflow: hidden;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 8px;
    white-space: nowrap;
    cursor: pointer;
  }

  .row:hover {
    background: var(--divider);
  }

  .row[aria-selected='true'] {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }

  .tree:focus-visible .cursor {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .chevron {
    flex: none;
    width: 10px;
  }

  .folder .chevron::before {
    content: '';
    display: block;
    width: 5px;
    height: 5px;
    margin-left: 1px;
    border-top: 1.5px solid var(--text-muted);
    border-right: 1.5px solid var(--text-muted);
    transform: rotate(45deg);
  }

  .folder.open .chevron::before {
    transform: rotate(135deg);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .message {
    margin: 0;
    padding: 4px 12px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
