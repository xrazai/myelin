<script lang="ts">
  import { tick } from 'svelte';
  import type { NoteProblems } from '../editor/note-saver';
  import { dropIndex, tabName, type Tabs } from '../tabs-model';

  let {
    tabs,
    problems,
    onactivate,
    onclose,
    onmove,
  }: {
    tabs: Tabs;
    /** Notes whose edits are not saved. */
    problems: NoteProblems;
    onactivate: (path: string) => void;
    onclose: (path: string) => void;
    onmove: (path: string, to: number) => void;
  } = $props();

  /** Pointer travel before a press becomes a drag. */
  const DRAG_THRESHOLD = 5;

  let strip = $state<HTMLDivElement>();
  let stripWidth = $state(0);
  /** The press that may become a drag. */
  let press: { pointer: number; path: string; startX: number } | null = null;
  /** The drag going on. `to`: where the tab lands; `marker`: where that is, in the strip. */
  let drag = $state.raw<{ path: string; to: number; marker: number | null } | null>(null);

  const tabElements = () => [...(strip?.querySelectorAll<HTMLElement>('.tab') ?? [])];

  function reveal() {
    strip?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  $effect(() => {
    // Runs after the DOM has the new active tab, order or width.
    if (tabs.active !== null && tabs.list.length > 0 && stripWidth > 0) reveal();
  });

  function endDrag() {
    press = null;
    drag = null;
  }

  function onpointerdown(event: PointerEvent, path: string) {
    if (event.button !== 0 || press) return;
    onactivate(path);
    press = { pointer: event.pointerId, path, startX: event.clientX };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onpointermove(event: PointerEvent) {
    if (!strip || event.pointerId !== press?.pointer) return;
    if (!drag && Math.abs(event.clientX - press.startX) < DRAG_THRESHOLD) return;
    const { path } = press;
    const from = tabs.list.findIndex((tab) => tab.path === path);
    if (from < 0) return endDrag();

    // Near an edge, the strip scrolls so that every place can be reached.
    const bounds = strip.getBoundingClientRect();
    if (event.clientX < bounds.left + 24) strip.scrollLeft -= 12;
    else if (event.clientX > bounds.right - 24) strip.scrollLeft += 12;

    const elements = tabElements();
    const x = event.clientX - bounds.left + strip.scrollLeft;
    const to = dropIndex(
      elements.map((element) => element.offsetLeft + element.offsetWidth / 2),
      x,
      from,
    );
    const target = elements[to];
    const marker = to === from || !target ? null : target.offsetLeft + (to > from ? target.offsetWidth - 2 : 0);
    drag = { path, to, marker };
  }

  function onpointerup(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return;
    if (drag) onmove(drag.path, drag.to);
    endDrag();
  }

  /** Arrows switch tabs, with `Alt` they move the tab; `Delete` closes it. */
  async function onkeydown(event: KeyboardEvent, index: number) {
    if (event.ctrlKey || event.metaKey) return;
    const { length } = tabs.list;
    const path = tabs.list[index]!.path;
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (event.altKey) {
      if (!step) return;
      onmove(path, index + step);
    } else if (step) {
      onactivate(tabs.list[(index + step + length) % length]!.path);
    } else if (event.key === 'Home' || event.key === 'End') {
      onactivate(tabs.list[event.key === 'Home' ? 0 : length - 1]!.path);
    } else if (event.key === 'Delete') {
      onclose(path);
    } else {
      return;
    }
    event.preventDefault();
    await tick();
    strip?.querySelector<HTMLElement>('.tab.active [role="tab"]')?.focus();
  }
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && drag && endDrag()} />

<div
  class={['strip', { dragging: drag }]}
  role="tablist"
  aria-label="Open notes"
  bind:this={strip}
  bind:clientWidth={stripWidth}
  onwheel={(event) => {
    if (strip) strip.scrollLeft += event.deltaY;
  }}
>
  {#each tabs.list as tab, index (tab.path)}
    {@const active = tab.path === tabs.active}
    {@const unsaved = problems.has(tab.path)}
    <div
      class={['tab', { active, unsaved, deleted: tab.deleted, lifted: drag?.path === tab.path }]}
      role="presentation"
      onauxclick={(event) => event.button === 1 && onclose(tab.path)}
      onmousedown={(event) => event.button === 1 && event.preventDefault()}
    >
      <button
        type="button"
        class="label"
        role="tab"
        aria-selected={active}
        tabindex={active ? 0 : -1}
        title={`${tab.path}${tab.deleted ? ' (deleted)' : ''}${unsaved ? ' (not saved)' : ''}`}
        onpointerdown={(event) => onpointerdown(event, tab.path)}
        {onpointermove}
        {onpointerup}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
        onclick={() => onactivate(tab.path)}
        onkeydown={(event) => onkeydown(event, index)}
      >
        {#if unsaved}
          <span class="mark" aria-label="Not saved">!</span>
        {:else}
          <span class="dot" aria-hidden="true"></span>
        {/if}
        <span class="title">{tabName(tab.path)}</span>
      </button>
      <button
        type="button"
        class="close"
        tabindex="-1"
        aria-label="Close {tabName(tab.path)}"
        title="Close (Ctrl+W)"
        onclick={() => onclose(tab.path)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d="M2.2 2.2 7.8 7.8M7.8 2.2 2.2 7.8" />
        </svg>
      </button>
    </div>
  {/each}
  {#if drag && drag.marker !== null}
    <div class="marker" role="none" style:left="{drag.marker}px"></div>
  {/if}
</div>

<style>
  .strip {
    position: relative;
    display: flex;
    gap: 4px;
    align-items: center;
    height: 100%;
    padding: 0 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tab {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    height: 28px;
    max-width: 220px;
    padding-right: 5px;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    font-size: 12.5px;
    transition:
      background-color var(--t-fast) ease,
      border-color var(--t-fast) ease,
      color var(--t-fast) ease,
      opacity var(--t-fast) ease,
      transform var(--t-fast) var(--ease-out);
  }

  .tab:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .tab.active {
    background: var(--bg-editor);
    border-color: var(--divider);
    box-shadow: inset 0 1px 0 var(--hairline);
    color: var(--text);
  }

  .tab.lifted {
    opacity: 0.48;
    transform: scale(0.98);
  }

  button {
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .label {
    display: flex;
    gap: 7px;
    align-items: center;
    height: 100%;
    min-width: 0;
    padding: 0 6px 0 10px;
    touch-action: none;
  }

  .label:active:not(:disabled) {
    transform: none;
  }

  .label:focus-visible {
    outline-offset: -2px;
    border-radius: 6px;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A shape, not only a color, marks the active tab. */
  .dot {
    flex: none;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: transparent;
    transform: scale(0.5);
    transition:
      background-color var(--t-fast) ease,
      transform var(--t-base) var(--ease-out);
  }

  .tab.active .dot {
    background: var(--accent);
    transform: scale(1);
  }

  .mark {
    flex: none;
    color: var(--learning);
    font-weight: 700;
  }

  .deleted .title {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  .close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: var(--text-muted);
    opacity: 0;
    pointer-events: none;
    transition:
      opacity var(--t-fast) ease,
      background-color var(--t-fast) ease,
      color var(--t-fast) ease,
      transform var(--t-fast) var(--ease-out);
  }

  .tab:hover .close,
  .tab.active .close,
  .tab:focus-within .close {
    opacity: 0.72;
    pointer-events: auto;
  }

  .close:hover {
    opacity: 1;
    background: var(--divider);
    color: var(--text);
  }

  .strip.dragging,
  .strip.dragging button {
    cursor: grabbing;
  }

  .marker {
    position: absolute;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-soft);
    pointer-events: none;
  }

  @media (forced-colors: active) {
    .tab.active .dot {
      forced-color-adjust: none;
      background: CanvasText;
    }
  }
</style>
