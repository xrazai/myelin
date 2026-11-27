<script lang="ts">
  import { tick } from 'svelte';
  import { searchCommands, type Command, type CommandId } from '../commands';
  import type { NoteList } from '../note-list';
  import { normalizeNewNotePath, type NoteMatch } from '../note-search';

  type PaletteItem =
    | { kind: 'note'; match: NoteMatch }
    | { kind: 'create'; path: string }
    | { kind: 'command'; command: Command };

  let {
    open,
    notes,
    recent,
    onopen,
    oncreate,
    oncommand,
    onclose,
  }: {
    open: boolean;
    notes: NoteList;
    recent: readonly string[];
    onopen: (path: string, newTab: boolean) => void;
    oncreate: (path: string, newTab: boolean) => void | Promise<void>;
    oncommand: (id: CommandId) => void;
    onclose: () => void;
  } = $props();

  let query = $state('');
  let selected = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let previousFocus: HTMLElement | null = null;

  const isCommandMode = $derived(query.startsWith('>'));

  const items = $derived.by((): PaletteItem[] => {
    if (isCommandMode) {
      return searchCommands(query.slice(1)).map((command) => ({ kind: 'command', command }));
    }
    const matches = notes.search(query, 50, recent);
    const result: PaletteItem[] = matches.map((match) => ({ kind: 'note', match }));
    const newPath = normalizeNewNotePath(query);
    if (newPath !== null) {
      const lower = newPath.toLowerCase();
      const exists = matches.some((m) => m.path.toLowerCase() === lower);
      if (!exists) result.push({ kind: 'create', path: newPath });
    }
    return result;
  });

  $effect(() => {
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
  });

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      query = '';
      selected = 0;
      void tick().then(() => inputEl?.focus());
    }
  });

  function close() {
    onclose();
    const target = previousFocus;
    previousFocus = null;
    void tick().then(() => target?.focus());
  }

  function activate(item: PaletteItem | undefined, newTab: boolean) {
    if (!item) return;
    close();
    if (item.kind === 'command') oncommand(item.command.id);
    else if (item.kind === 'note') onopen(item.match.path, newTab);
    else void oncreate(item.path, newTab);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length > 0) selected = (selected + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0) selected = (selected - 1 + items.length) % items.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(items[selected], event.ctrlKey);
    }
  }
</script>

{#if open}
  <div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="Open note, or type > for commands"
        aria-label="Search notes or commands"
        {onkeydown}
      />
      <ul role="listbox">
        {#each items as item, index}
          <li
            role="option"
            aria-selected={index === selected}
            class:selected={index === selected}
            onmouseenter={() => (selected = index)}
            onmousedown={(e) => {
              e.preventDefault();
              activate(item, e.ctrlKey);
            }}
          >
            {#if item.kind === 'note'}
              <span class="primary">{item.match.name}</span>
              {#if item.match.folder}
                <span class="secondary">{item.match.folder}</span>
              {/if}
            {:else if item.kind === 'create'}
              <span class="primary create">Create note "{item.path}"</span>
              <span class="secondary">Enter</span>
            {:else}
              <span class="primary">{item.command.label}</span>
              <kbd class="secondary">{item.command.shortcut}</kbd>
            {/if}
          </li>
        {:else}
          <li class="empty">No matching {isCommandMode ? 'commands' : 'notes'}</li>
        {/each}
      </ul>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: color-mix(in srgb, var(--bg-panel) 70%, transparent);
  }

  .palette {
    width: min(560px, 90vw);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  input {
    width: 100%;
    background: var(--bg-editor);
    border: 1px solid var(--divider);
    color: var(--text);
  }

  input:focus {
    border-color: var(--accent);
    outline: 1px solid transparent;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    border-radius: 4px;
    border-left: 2px solid transparent;
    cursor: pointer;
  }

  li.selected {
    background: var(--bg-editor);
    border-left-color: var(--accent);
  }

  .primary {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .primary.create {
    color: var(--accent);
  }

  .secondary {
    color: var(--text-muted);
    font-size: 12px;
    flex-shrink: 0;
  }

  .empty {
    color: var(--text-muted);
    cursor: default;
  }
</style>
