<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import { createNoteEditor } from '../editor/cm-editor';
  import { connectEditor, type EditorStatus } from '../editor/editor-tabs';
  import { tabName, type Tabs } from '../tabs-model';

  let { vault, tabs }: { vault: VaultInfo; tabs: Tabs } = $props();

  const active = $derived(tabs.list.find((tab) => tab.path === tabs.active) ?? null);

  let container = $state<HTMLDivElement>();
  let status = $state.raw<EditorStatus>({ kind: 'empty' });
  let connection = $state.raw<ReturnType<typeof connectEditor>>();

  // The editor is plain TS inside this container: Svelte renders nothing in it.
  $effect(() => {
    const parent = container;
    if (!parent) return;
    return untrack(() => {
      const editor = createNoteEditor(parent);
      const connected = connectEditor(
        editor,
        (path) => window.myelin.readNote(path),
        (next) => {
          status = next;
          // Before the editor shows a note, so that it can measure and scroll it.
          parent.hidden = next.kind !== 'ready';
        },
      );
      connection = connected;
      return () => {
        connected.stop();
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
  {#if active?.deleted && status.kind === 'ready'}
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
