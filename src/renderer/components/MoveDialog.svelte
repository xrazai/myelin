<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fold } from '../note-search';

  /** Picks the folder to move into. Keyboard: type to filter, arrows, `Enter`, `Escape`. */
  let {
    name,
    folders,
    onpick,
    onclose,
  }: {
    name: string;
    /** Destinations, `''` for the vault root. */
    folders: string[];
    onpick: (folder: string) => void;
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();
  let query = $state('');
  let selected = $state(0);
  let picked: string | null = null;

  const label = (folder: string) => folder || 'Vault root';
  /** Enough to choose from; typing narrows it down. */
  const shown = $derived(folders.filter((folder) => fold(label(folder)).includes(fold(query.trim()))).slice(0, 200));

  onMount(() => {
    dialog?.showModal();
    input?.focus();
  });

  function pick(folder: string | undefined) {
    if (folder === undefined) return;
    picked = folder;
    dialog?.close();
  }

  async function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[selected]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      await tick();
      list?.children[selected]?.scrollIntoView({ block: 'nearest' });
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="move-title"
  onclose={() => {
    // The dialog has given the focus back already. `onclose` last: it drops what `onpick` needs.
    if (picked !== null) onpick(picked);
    onclose();
  }}
>
  <h2 id="move-title">Move “{name}” to…</h2>
  <input
    bind:this={input}
    bind:value={query}
    aria-label="Filter folders"
    aria-controls="move-folders"
    aria-activedescendant={shown.length > 0 ? `move-folder-${selected}` : undefined}
    autocomplete="off"
    spellcheck="false"
    oninput={() => (selected = 0)}
    {onkeydown}
  />
  <ul bind:this={list} id="move-folders" role="listbox">
    {#each shown as folder, index (folder)}
      <!-- svelte-ignore a11y_click_events_have_key_events (the keys are on the input) -->
      <li
        id="move-folder-{index}"
        role="option"
        aria-selected={index === selected}
        onclick={() => pick(folder)}
        onmouseenter={() => (selected = index)}
      >
        {label(folder)}
      </li>
    {:else}
      <li class="empty">No folder to move to</li>
    {/each}
  </ul>
</dialog>

<style>
  dialog {
    width: min(440px, 90vw);
    padding: 16px;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 10px;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 50%);
  }

  h2 {
    margin: 0 0 10px;
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  input {
    width: 100%;
    padding: 4px 8px;
    color: var(--text);
    background: var(--bg-editor);
    border: 1px solid var(--divider);
    border-radius: 6px;
    font: inherit;
  }

  input:focus {
    border-color: var(--accent);
    outline: 1px solid transparent;
  }

  ul {
    max-height: 40vh;
    margin: 8px 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  li {
    padding: 5px 10px;
    border-radius: 5px;
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  li[aria-selected='true'] {
    background: var(--surface-active);
  }

  .empty {
    color: var(--text-muted);
    cursor: default;
  }
</style>
