<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import { createNoteEditor } from '../editor/cm-editor';
  import { connectEditor, type EditorStatus } from '../editor/editor-tabs';
  import { createNoteSaver, type NoteProblems, type NoteSaver } from '../editor/note-saver';
  import { tabName, type Tabs } from '../tabs-model';

  let {
    vault,
    tabs,
    problems,
    onsaver,
    onproblems,
    ondiscard,
  }: {
    vault: VaultInfo;
    tabs: Tabs;
    problems: NoteProblems;
    /** The saver of the mounted editor, `null` once it is gone. */
    onsaver: (saver: NoteSaver | null) => void;
    onproblems: (problems: NoteProblems) => void;
    /** Close the note's tab and give up its unsaved text. */
    ondiscard: (path: string) => void;
  } = $props();

  const active = $derived(tabs.list.find((tab) => tab.path === tabs.active) ?? null);
  const problem = $derived((active && problems.get(active.path)) || null);
  let saver = $state.raw<NoteSaver>();

  let container = $state<HTMLDivElement>();
  let status = $state.raw<EditorStatus>({ kind: 'empty' });
  let connection = $state.raw<ReturnType<typeof connectEditor>>();

  // The editor is plain TS inside this container: Svelte renders nothing in it.
  $effect(() => {
    const parent = container;
    if (!parent) return;
    return untrack(() => {
      const editor = createNoteEditor(parent, [], (path) => notes.edited(path));
      const notes = createNoteSaver(editor, window.myelin);
      const unsubscribe = [window.myelin.onVaultEvents(notes.external), notes.subscribe(onproblems)];
      const connected = connectEditor(editor, notes, (next) => {
        status = next;
        // Before the editor shows a note, so that it can measure and scroll it.
        parent.hidden = next.kind !== 'ready';
      });
      saver = notes;
      onsaver(notes);
      connection = connected;
      return () => {
        onsaver(null);
        for (const stop of unsubscribe) stop();
        connected.stop();
        notes.stop();
        editor.destroy();
      };
    });
  });

  $effect(() => {
    const next = tabs;
    const connected = connection;
    untrack(() => connected?.sync(next));
  });
</script>

<div class="editor">
  {#if active && problem && status.kind === 'ready'}
    {@const path = active.path}
    <div class="notice problem" role="alert">
      {#if problem.kind === 'changed'}
        <p>
          This note changed on disk. Your edits are not saved.
          {#if problem.message}Could not load the disk version: {problem.message}{/if}
        </p>
        <button type="button" onclick={() => saver?.keepMine(path)}>Keep mine</button>
        <button type="button" onclick={() => saver?.loadDisk(path)}>Load disk version</button>
      {:else if problem.kind === 'deleted'}
        <p>This note was deleted on disk. Your edits are not saved.</p>
        <button type="button" onclick={() => saver?.keepMine(path)}>Save it again</button>
        <button type="button" onclick={() => ondiscard(path)}>Discard and close</button>
      {:else}
        <p>Could not save this note: {problem.message}. Your text is still here.</p>
        <button type="button" onclick={() => saver?.save(path)}>Try again</button>
        <button type="button" onclick={() => ondiscard(path)}>Discard and close</button>
      {/if}
    </div>
  {:else if active?.deleted && status.kind === 'ready'}
    <p class="notice" role="status">This note was deleted.</p>
  {/if}
  <div class="host" bind:this={container}></div>
  {#if !active}
    <div class="message">
      <p>Select a note in the file tree.</p>
      <p class="path">{vault.root}</p>
    </div>
  {:else if status.kind !== 'ready'}
    <div class="message">
      <h2 class="prose">{tabName(active.path)}</h2>
      <p class="path">{active.path}</p>
      {#if active.deleted}
        <p>This note was deleted.</p>
      {:else if status.kind === 'error'}
        <p role="alert">Could not read this note: {status.message}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .host {
    flex: 1;
    min-height: 0;
  }

  .host:global([hidden]) {
    display: none;
  }

  .notice {
    margin: 0;
    padding: 6px 32px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--divider);
  }

  .problem {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    color: var(--text);
    background: var(--bg-panel);
  }

  .problem p {
    flex: 1 1 240px;
    margin: 0;
    color: inherit;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .problem button {
    padding: 3px 10px;
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    cursor: pointer;
  }

  .problem button:hover {
    border-color: var(--accent);
  }

  .message {
    overflow: auto;
    padding: 32px 48px;
  }

  h2 {
    margin: 0;
    font-size: 28px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  p {
    margin: 8px 0 0;
    color: var(--text-muted);
  }

  .path {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
