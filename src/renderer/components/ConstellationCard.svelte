<script lang="ts">
  import type { ConstellationInfo } from '../constellation';

  /**
   * The chosen constellation. The arrows move between its related constellations, `Enter`
   * goes to one, `Escape` closes.
   */
  let {
    info,
    onopen,
    onselect,
    onclose,
  }: {
    info: ConstellationInfo;
    onopen: (path: string) => void;
    onselect: (id: number) => void;
    onclose: () => void;
  } = $props();

  let card: HTMLElement;
  let relatedList = $state<HTMLUListElement>();

  export function focus() {
    card.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      return onclose();
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    const buttons = [...(relatedList?.querySelectorAll('button') ?? [])];
    if (buttons.length === 0) return;
    event.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = at === -1 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
    buttons[next]!.focus();
  }
</script>

<!-- The keys belong to the buttons inside; the card takes the focus so that they work at once. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section bind:this={card} tabindex="0" aria-label="Constellation {info.name}" {onkeydown}>
  <header>
    <h2>{info.name}</h2>
    <span>{info.size} notes</span>
    <button type="button" class="close" aria-label="Close the constellation card" onclick={onclose}>×</button>
  </header>

  <h3>Main notes</h3>
  <ul>
    {#each info.main as note (note.path)}
      <li><button type="button" title={note.path} onclick={() => onopen(note.path)}>{note.title}</button></li>
    {/each}
  </ul>

  {#if info.related.length > 0}
    <h3>Related</h3>
    <ul bind:this={relatedList}>
      {#each info.related as other (other.id)}
        <li>
          <button type="button" onclick={() => onselect(other.id)}>
            {other.name} <span>{other.size}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if info.recent.length > 0}
    <h3>Recently edited</h3>
    <ul>
      {#each info.recent as note (note.path)}
        <li><button type="button" title={note.path} onclick={() => onopen(note.path)}>{note.title}</button></li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section {
    flex: none;
    max-height: 60%;
    padding: 0 6px 8px;
    overflow-y: auto;
    border-top: 1px solid var(--divider);
  }

  section:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  header {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 10px 6px 2px;
  }

  h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  header span,
  li span {
    color: var(--text-muted);
    font-size: 12px;
  }

  h3 {
    margin: 0;
    padding: 8px 6px 2px;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  button {
    width: 100%;
    padding: 3px 6px;
    overflow: hidden;
    color: var(--text);
    font-size: 12.8px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  button:hover {
    background: var(--surface-hover);
  }

  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .close {
    width: auto;
    margin-left: auto;
    color: var(--text-muted);
  }
</style>
