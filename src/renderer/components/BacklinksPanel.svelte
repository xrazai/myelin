<script lang="ts">
  import { untrack } from 'svelte';
  import type { Backlink } from '../../shared/ipc';
  import { errorMessage } from '../error-message';
  import { tabName } from '../tabs-model';

  /**
   * The notes that link to the open note. `revision` moves on whenever links may have
   * changed: a save, a change outside the app, the end of indexing.
   */
  let {
    path,
    revision,
    onopen,
  }: {
    path: string | null;
    revision: number;
    onopen: (link: Backlink) => void;
  } = $props();

  /** `null`: the vault is still being indexed. `undefined`: not known yet. */
  let links = $state.raw<Backlink[] | null | undefined>(undefined);
  let error = $state('');
  let shownFor: string | null = null;

  $effect(() => {
    const note = path;
    void revision;
    // Another note's list must not linger while this one loads.
    if (note !== untrack(() => shownFor)) {
      links = undefined;
      shownFor = note;
    }
    error = '';
    if (note === null) return;
    let current = true;
    window.myelin.getBacklinks(note).then(
      (found) => current && (links = found),
      (reason: unknown) => current && (error = errorMessage(reason)),
    );
    return () => (current = false);
  });
</script>

<section aria-labelledby="backlinks-title">
  <h2 id="backlinks-title">Linked from</h2>
  {#if path === null}
    <p>Open a note to see what links to it.</p>
  {:else if error}
    <p role="alert">Could not list the links. {error}</p>
  {:else if links === null}
    <p>The vault is still being indexed.</p>
  {:else if links && links.length === 0}
    <p>No other note links here.</p>
  {:else if links}
    <ul>
      {#each links as link (`${link.path}:${link.line}:${link.column}`)}
        <li>
          <button type="button" title={link.path} onclick={() => onopen(link)}>
            <span class="name">{tabName(link.path)}</span>
            <span class="line">{link.text}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--divider);
  }

  h2 {
    flex: none;
    margin: 0;
    padding: 10px 12px 6px;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }

  p {
    margin: 0;
    padding: 4px 12px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  ul {
    min-height: 0;
    margin: 0;
    padding: 0 6px 12px;
    overflow-y: auto;
    list-style: none;
  }

  button {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px 8px;
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

  .name {
    font-size: 12.8px;
    font-weight: 500;
  }

  .line {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 12px;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
</style>
