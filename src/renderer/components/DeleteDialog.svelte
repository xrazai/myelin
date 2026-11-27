<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { DeleteInfo } from '../../shared/ipc';
  import { deleteWarnings, type DeleteOutcome, type DeleteTarget } from '../delete-item';
  import { errorMessage } from '../error-message';

  /**
   * Confirms a deletion. Modal from the question to the end of the move, so that nothing is
   * typed into a tab about to close.
   */
  let {
    target,
    ondelete,
    onclose,
  }: {
    target: DeleteTarget;
    ondelete: (discard: readonly string[]) => Promise<DeleteOutcome>;
    onclose: (deleted: boolean) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let cancel = $state<HTMLButtonElement>();
  let info = $state.raw<DeleteInfo | null>(null);
  /** Open notes whose text could not be saved: deleting them now needs another yes. */
  let unsaved = $state.raw<string[] | null>(null);
  let working = $state(false);
  let error = $state('');
  let deleted = false;

  const name = $derived(target.path.slice(target.path.lastIndexOf('/') + 1).replace(/\.md$/i, ''));

  onMount(() => {
    dialog?.showModal();
    // The safe choice has the focus: a stray `Enter` deletes nothing.
    cancel?.focus();
    window.myelin.deleteInfo(target.path, target.kind).then(
      (found) => (info = found),
      (reason: unknown) => (error = errorMessage(reason)),
    );
  });

  async function confirm() {
    if (working || !info) return;
    working = true;
    error = '';
    try {
      const outcome = await ondelete(unsaved ?? []);
      if (outcome.status === 'deleted') {
        deleted = true;
        dialog?.close();
        return;
      }
      unsaved = outcome.paths;
    } catch (reason) {
      error = errorMessage(reason);
    }
    working = false;
    await tick();
    cancel?.focus();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="delete-title"
  oncancel={(event) => working && event.preventDefault()}
  onclose={() => {
    // A second `Escape` closes a dialog whatever `cancel` says: back until the move ends.
    if (working && !deleted) dialog?.showModal();
    else onclose(deleted);
  }}
>
  <h2 id="delete-title">Move “{name}” to the Recycle Bin?</h2>
  {#if target.path.includes('/')}
    <p class="where">{target.path}</p>
  {/if}
  {#if info}
    {#each deleteWarnings(target.kind, info) as line (line)}
      <p>{line}</p>
    {/each}
  {:else if !error}
    <p>Looking at what would go…</p>
  {/if}
  {#if unsaved}
    <p role="alert">Not saved, so nothing was deleted: {unsaved.join(', ')}. Deleting now loses the unsaved text.</p>
  {/if}
  {#if error}
    <p role="alert">{error}</p>
  {/if}
  <div class="buttons">
    <button type="button" bind:this={cancel} disabled={working} onclick={() => dialog?.close()}>Cancel</button>
    <button type="button" class="danger" disabled={working || !info} onclick={confirm}>
      {#if working}Deleting…{:else if unsaved}Delete and lose that text{:else}Move to Recycle Bin{/if}
    </button>
  </div>
</dialog>

<style>
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

  h2 {
    margin: 0;
    font-size: 16px;
    overflow-wrap: anywhere;
  }

  p {
    margin: 10px 0 0;
    overflow-wrap: anywhere;
  }

  .where {
    color: var(--text-muted);
    font-size: 12px;
  }

  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  button {
    padding: 4px 12px;
    color: var(--text);
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    cursor: pointer;
  }

  button:hover:enabled {
    border-color: var(--accent);
  }

  button:disabled {
    color: var(--text-muted);
    cursor: default;
  }
</style>
