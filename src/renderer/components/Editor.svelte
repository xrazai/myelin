<script lang="ts">
  import { untrack } from 'svelte';
  import type { VaultInfo } from '../../shared/ipc';
  import { createNoteEditor, type NoteEditor } from '../editor/cm-editor';
  import { connectEditor, type EditorStatus } from '../editor/editor-tabs';
  import { TOGGLE_PARAGRAPH_FOCUS_EVENT } from '../editor/focus-dim';
  import { linkCompletion } from '../editor/link-complete';
  import { linkDestination, linkFollowing, type FollowLink } from '../editor/link-follow';
  import { linkHover } from '../editor/link-hover';
  import { LINK_PULSE_EVENT, linkPulse } from '../editor/link-pulse';
  import { computeNoteMetrics, type NoteMetrics } from '../editor/note-metrics';
  import { createNoteSaver, type NoteProblems, type NoteSaver } from '../editor/note-saver';
  import { errorMessage } from '../error-message';
  import { createNoteCache } from '../note-cache';
  import { watchNoteList } from '../note-list';
  import { tabName, type Tabs } from '../tabs-model';

  let {
    vault,
    tabs,
    problems,
    focusMode = false,
    onsaver,
    onproblems,
    ondiscard,
    onfollow,
    onmetrics,
    onfocusmode,
  }: {
    vault: VaultInfo;
    tabs: Tabs;
    problems: NoteProblems;
    focusMode?: boolean;
    /** The saver of the mounted editor, `null` once it is gone. */
    onsaver: (saver: NoteSaver | null) => void;
    onproblems: (problems: NoteProblems) => void;
    /** Close the note's tab and give up its unsaved text. */
    ondiscard: (path: string) => void;
    /** Open the note a link of `source` leads to, in its place or in a new tab. */
    onfollow: (path: string, source: string, newTab: boolean) => void;
    /** Debounced reading metrics for the active note, or `null` when none is shown. */
    onmetrics?: (metrics: NoteMetrics | null) => void;
    /** Toggles Focus Mode from the quiet editor chrome. */
    onfocusmode?: () => void;
  } = $props();

  /** Why the last link followed could not be opened. */
  let linkError = $state('');
  let scrolled = $state(false);
  let typing = $state(false);
  let paragraphFocus = $state(false);
  let editorApi = $state.raw<NoteEditor>();

  const active = $derived(tabs.list.find((tab) => tab.path === tabs.active) ?? null);
  const folders = $derived(active ? active.path.split('/').slice(0, -1) : []);
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
      const list = watchNoteList(window.myelin);
      const cache = createNoteCache(window.myelin);
      const follow: FollowLink = (link, source, newTab) => {
        linkError = '';
        linkDestination(list, window.myelin, link.target, source, (path) => tabs.list.some((tab) => tab.path === path)).then(
          (path) => onfollow(path, source, newTab),
          (error: unknown) => (linkError = `Could not open the link. ${errorMessage(error)}`),
        );
      };
      const links = [
        linkFollowing(follow),
        linkCompletion({
          notes: list,
          readText: async (path) => (editor.has(path) ? editor.text(path) : window.myelin.readNote(path)),
        }),
        linkHover({ notes: list, cache }),
      ];
      let metricsTimer: ReturnType<typeof setTimeout> | undefined;
      let typingTimer: ReturnType<typeof setTimeout> | undefined;
      let activePath: string | null = null;
      const emitMetrics = (path: string | null) => {
        clearTimeout(metricsTimer);
        if (!path || !editor.has(path)) {
          onmetrics?.(null);
          return;
        }
        onmetrics?.(computeNoteMetrics(editor.text(path)));
      };
      const scheduleMetrics = (path: string) => {
        clearTimeout(metricsTimer);
        metricsTimer = setTimeout(() => {
          if (activePath === path && editor.has(path)) onmetrics?.(computeNoteMetrics(editor.text(path)));
        }, 250);
      };
      const markTyping = () => {
        typing = true;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          typing = false;
        }, 1100);
      };
      const editor = createNoteEditor(parent, links, (path) => {
        notes.edited(path);
        markTyping();
        if (activePath === path) scheduleMetrics(path);
      });
      editorApi = editor;
      const scroller = parent.querySelector<HTMLElement>('.cm-scroller');
      const onScroll = () => {
        scrolled = (scroller?.scrollTop ?? 0) > 12;
      };
      scroller?.addEventListener('scroll', onScroll, { passive: true });
      const notes = createNoteSaver(editor, window.myelin, (path, before, after) => {
        cache.invalidate(path);
        if (activePath === path) scheduleMetrics(path);
        const pulse = list.isLoaded() ? linkPulse(path, before, after, list.resolve) : null;
        if (pulse) window.dispatchEvent(new CustomEvent(LINK_PULSE_EVENT, { detail: pulse }));
      });
      const unsubscribe = [window.myelin.onVaultEvents(notes.external), notes.subscribe(onproblems)];
      const connected = connectEditor(editor, notes, (next) => {
        status = next;
        // Before the editor shows a note, so that it can measure and scroll it.
        parent.hidden = next.kind !== 'ready';
        activePath = next.kind === 'ready' ? tabs.active : null;
        scrolled = (scroller?.scrollTop ?? 0) > 12;
        emitMetrics(activePath);
      });
      saver = notes;
      onsaver(notes);
      connection = connected;
      return () => {
        clearTimeout(metricsTimer);
        clearTimeout(typingTimer);
        scroller?.removeEventListener('scroll', onScroll);
        onmetrics?.(null);
        onsaver(null);
        for (const stop of unsubscribe) stop();
        connected.stop();
        cache.stop();
        list.stop();
        notes.stop();
        editorApi = undefined;
        editor.destroy();
      };
    });
  });

  $effect(() => {
    editorApi?.setFocusDim(paragraphFocus);
  });

  // Command palette (#31) or keyboard extensions can toggle paragraph dimming without tight coupling.
  $effect(() => {
    const onToggle = () => (paragraphFocus = !paragraphFocus);
    window.addEventListener(TOGGLE_PARAGRAPH_FOCUS_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_PARAGRAPH_FOCUS_EVENT, onToggle);
  });

  // The message is about the note the link is in.
  $effect(() => {
    void tabs.active;
    untrack(() => (linkError = ''));
  });

  $effect(() => {
    const next = tabs;
    const connected = connection;
    untrack(() => connected?.sync(next));
  });
</script>

<div class={['editor', { scrolled, typing }]}>
  {#if active && status.kind === 'ready'}
    <header class="chrome" aria-label="Current note">
      <div class="breadcrumb" title={active.path}>
        {#each folders as segment}
          <span class="crumb">{segment}</span>
          <span class="sep" aria-hidden="true">/</span>
        {/each}
        <span class="current">{tabName(active.path)}</span>
      </div>
      <div class="chrome-tools">
        <button
          type="button"
          class="chrome-btn"
          aria-pressed={paragraphFocus}
          title="Dim surrounding paragraphs for deep reading"
          onclick={() => (paragraphFocus = !paragraphFocus)}
        >
          Dim
        </button>
        {#if onfocusmode}
          <button
            type="button"
            class="chrome-btn"
            aria-pressed={focusMode}
            title="Focus mode (Ctrl+\)"
            onclick={onfocusmode}
          >
            Focus
          </button>
        {/if}
      </div>
    </header>
  {/if}
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
  {#if linkError}
    <div class="notice problem" role="alert">
      <p>{linkError}</p>
      <button type="button" onclick={() => (linkError = '')}>Dismiss</button>
    </div>
  {/if}
  <div class="host" bind:this={container}></div>
  {#if !active}
    <div class="empty">
      <div class="empty-mark" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 19c4-1 8-5 14-14-9 6-13 10-14 14Z" />
          <path d="M9.5 14.5 15 9" />
          <circle cx="17.5" cy="6.5" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <p class="empty-title prose">Select a note, or jump straight in.</p>
      <p class="empty-path">{vault.root}</p>
      <dl class="shortcuts">
        <div>
          <dt><kbd>Ctrl+P</kbd></dt>
          <dd>Quick open</dd>
        </div>
        <div>
          <dt><kbd>Ctrl+\</kbd></dt>
          <dd>Focus mode</dd>
        </div>
        <div>
          <dt><kbd>Ctrl+Shift+L</kbd></dt>
          <dd>Graph / Brain</dd>
        </div>
      </dl>
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

  .chrome {
    display: flex;
    flex: none;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 20px;
    border-bottom: 1px solid transparent;
    color: var(--text-muted);
    font-size: 12px;
    user-select: none;
    transition:
      opacity 240ms ease,
      border-color var(--t-base) ease;
  }

  .editor.scrolled .chrome {
    border-bottom-color: color-mix(in srgb, var(--divider) 78%, transparent);
  }

  .editor.typing .chrome {
    opacity: 0.32;
  }

  .editor.typing .chrome:hover,
  .editor.typing .chrome:focus-within {
    opacity: 1;
  }

  .breadcrumb {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .crumb {
    color: var(--text-muted);
  }

  .sep {
    opacity: 0.4;
  }

  .current {
    overflow: hidden;
    color: var(--text);
    font-weight: 500;
    text-overflow: ellipsis;
  }

  .chrome-tools {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
  }

  .chrome-btn {
    height: 22px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--text-muted);
    font-size: 11.5px;
    cursor: pointer;
  }

  .chrome-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .chrome-btn[aria-pressed='true'] {
    background: var(--surface-active);
    border-color: color-mix(in srgb, var(--accent) 28%, transparent);
    color: var(--accent);
  }

  .host {
    flex: 1;
    min-height: 0;
  }

  .host:global([hidden]) {
    display: none;
  }

  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
    text-align: center;
  }

  .empty-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    margin-bottom: 14px;
    color: var(--accent);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 10px;
    opacity: 0.85;
  }

  .empty-title {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .empty-path {
    max-width: 52ch;
    margin: 6px 0 24px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
    user-select: text;
  }

  .shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    justify-content: center;
    margin: 0;
  }

  .shortcuts div {
    display: flex;
    gap: 7px;
    align-items: center;
  }

  .shortcuts dt,
  .shortcuts dd {
    margin: 0;
  }

  .shortcuts dd {
    font-size: 12px;
    color: var(--text-muted);
  }

  .shortcuts kbd {
    padding: 2px 6px;
    border-radius: 5px;
    font-size: 11px;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
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
