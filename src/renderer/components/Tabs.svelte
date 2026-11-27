<script lang="ts">
  import { tick } from 'svelte';
  import { dropIndex, tabName, type Tabs } from '../tabs-model';

  let {
    tabs,
    onactivate,
    onclose,
    onmove,
  }: {
    tabs: Tabs;
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
    <div
      class={['tab', { active, deleted: tab.deleted, lifted: drag?.path === tab.path }]}
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
        title={tab.deleted ? `${tab.path} (deleted)` : tab.path}
        onpointerdown={(event) => onpointerdown(event, tab.path)}
        {onpointermove}
        {onpointerup}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
        onclick={() => onactivate(tab.path)}
        onkeydown={(event) => onkeydown(event, index)}
      >
        {tabName(tab.path)}
      </button>
      <button
        type="button"
        class="close"
        tabindex="-1"
        aria-label="Close {tabName(tab.path)}"
        title="Close (Ctrl+W)"
        onclick={() => onclose(tab.path)}
      ></button>
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
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tab {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    max-width: 220px;
    padding-right: 6px;
    color: var(--text-muted);
    border-right: 1px solid var(--divider);
  }

  .tab.active {
    background: var(--bg-editor);
    color: var(--text);
  }

  /* A shape, not only a color, marks the active tab. */
  .tab.active::after {
    content: '';
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    border-bottom: 2px solid var(--accent);
  }

  .tab.lifted {
    opacity: 0.5;
  }

  button {
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .label {
    height: 100%;
    padding: 0 6px 0 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    touch-action: none;
  }

  .label:focus-visible {
    outline-offset: -2px;
  }

  .deleted .label {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  .close {
    flex: none;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: var(--text-muted);
    visibility: hidden;
  }

  .close::before {
    content: '×';
    font-size: 15px;
    line-height: 1;
  }

  .tab:hover .close,
  .tab.active .close {
    visibility: visible;
  }

  .close:hover {
    background: var(--divider);
    color: var(--text);
  }

  .strip.dragging,
  .strip.dragging button {
    cursor: grabbing;
  }

  .marker {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 2px;
    background: var(--accent);
    pointer-events: none;
  }
</style>
