<script lang="ts">
  import { tick } from 'svelte';
  import type { SearchCard } from '../../shared/ipc';
  import { highlightParts } from '../highlight';
  import { errorMessage } from '../error-message';

  /**
   * Searches the vault. `revision` moves on when notes may have changed; `indexing`: the
   * vault is not all in yet.
   */
  let {
    revision,
    indexing,
    onopen,
  }: {
    revision: number;
    indexing: boolean;
    onopen: (card: SearchCard) => void;
  } = $props();

  /** A broad search takes a while on a large vault: only after a pause in typing (#116). */
  const PAUSE_MS = 250;

  let query = $state('');
  let asked = $state('');
  /** `null`: nothing asked, or no answer yet. */
  let cards = $state.raw<SearchCard[] | null>(null);
  let error = $state('');
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();

  export function focus() {
    input?.focus();
    input?.select();
  }

  $effect(() => {
    const next = query.trim();
    const timer = setTimeout(() => (asked = next), next === '' ? 0 : PAUSE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const wanted = asked;
    void revision;
    void indexing;
    error = '';
    if (wanted === '') {
      cards = null;
      return;
    }
    // An answer to an older query is dropped.
    let current = true;
    window.myelin.search(wanted).then(
      (found) => current && (cards = found),
      (reason: unknown) => current && (error = errorMessage(reason)),
    );
    return () => (current = false);
  });

  const buttons = () => [...(list?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

  /** Arrows go from the box through the cards and back. */
  async function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
      if (event.key === 'Enter' && event.target === input && cards?.[0] && asked === query.trim()) onopen(cards[0]);
      return;
    }
    event.preventDefault();
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    await tick();
    if (next < 0) input?.focus();
    else all[Math.min(next, all.length - 1)]?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (arrow keys among the box and the cards inside) -->
<div class="brain" role="search" {onkeydown}>
  <input bind:this={input} bind:value={query} type="text" placeholder="Search your vault" aria-label="Search your vault" autocomplete="off" spellcheck="false" />
  <div class="results" aria-live="polite">
    {#if indexing && asked !== ''}
      <p>Still indexing: results may be incomplete.</p>
    {/if}
    {#if error}
      <p role="alert">Could not search. {error}</p>
    {:else if asked === ''}
      <p>Results are excerpts of your notes, with their sources.</p>
    {:else if cards && cards.length === 0}
      <p>No note matches.</p>
    {:else if cards}
      <ul bind:this={list}>
        {#each cards as card (card.path)}
          <li>
            <button type="button" title={card.path} onclick={() => onopen(card)}>
              <span class="title">{card.title}</span>
              <span class="excerpt">
                {#each highlightParts(card.excerpt, card.matches) as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if cards && cards.length > 0}
    <footer>
      <strong>Answered from your local vault</strong>
      <span>Sources: {cards.map((card) => card.path).join(', ')}</span>
    </footer>
  {/if}
</div>

<style>
  .brain {
    display: flex;
    flex: 2;
    flex-direction: column;
    min-height: 0;
  }

  input {
    flex: none;
    margin: 0 12px 8px;
    padding: 6px 9px;
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

  .results {
    flex: 1;
    min-height: 0;
    padding: 0 6px;
    overflow-y: auto;
  }

  p {
    margin: 0;
    padding: 4px 6px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0;
    padding: 0 0 8px;
    list-style: none;
  }

  button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 8px;
    color: var(--text);
    background: none;
    border: 0;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
  }

  button:hover {
    background: var(--surface-hover);
  }

  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .title {
    color: var(--accent);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .excerpt {
    color: var(--text-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  mark {
    color: var(--text);
    background: var(--accent-soft);
    border-radius: 2px;
  }

  footer {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 2px;
    max-height: 72px;
    padding: 6px 12px;
    overflow-y: auto;
    color: var(--learning);
    border-top: 1px solid var(--divider);
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }
</style>
