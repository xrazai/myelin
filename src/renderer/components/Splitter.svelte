<!-- The 1px divider beside a side column, dragged or moved with the arrows to resize it. -->
<script lang="ts">
  import type { Side } from '../panel-layout';

  let {
    side,
    label,
    value,
    min,
    max,
    onresize,
    oncommit,
    onreset,
  }: {
    /** The column this divider resizes. */
    side: Side;
    label: string;
    value: number;
    min: number;
    max: number;
    /** A wanted width, not yet limited to `min`/`max`. */
    onresize: (width: number) => void;
    /** A resize ended: time to remember it. */
    oncommit: () => void;
    onreset: () => void;
  } = $props();

  const KEY_STEP = 16;
  /** Moving right widens the left column and narrows the right one. */
  const direction = $derived(side === 'left' ? 1 : -1);

  let drag = $state.raw<{ pointer: number; startX: number; startWidth: number; moved: boolean } | null>(null);

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, startX: event.clientX, startWidth: value, moved: false };
  }

  function onpointermove(event: PointerEvent) {
    if (event.pointerId !== drag?.pointer) return;
    const travel = event.clientX - drag.startX;
    if (travel !== 0) drag.moved = true;
    if (drag.moved) onresize(drag.startWidth + travel * direction);
  }

  // Runs after `pointerup` and `pointercancel` too: the capture ends with them.
  function onlostpointercapture() {
    const moved = drag?.moved;
    drag = null;
    if (moved) oncommit();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    let width: number;
    if (event.key === 'ArrowLeft') width = value - KEY_STEP * direction;
    else if (event.key === 'ArrowRight') width = value + KEY_STEP * direction;
    else if (event.key === 'Home') width = min;
    else if (event.key === 'End') width = max;
    else return;
    event.preventDefault();
    onresize(width);
    oncommit();
  }
</script>

<!-- A focusable separator is a widget (WAI-ARIA "window splitter"). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class={['splitter', { active: drag }]}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  {onpointerdown}
  {onpointermove}
  {onlostpointercapture}
  ondblclick={onreset}
  {onkeydown}
></div>

<style>
  .splitter {
    position: relative;
    z-index: 1;
    background: var(--divider);
  }

  /* The grab area is wider than the line. */
  .splitter::before {
    content: '';
    position: absolute;
    inset: 0 -3px;
    cursor: col-resize;
    touch-action: none;
  }

  /* While the pointer is captured the cursor comes from this element. */
  .splitter.active {
    cursor: col-resize;
  }

  .splitter:hover,
  .splitter.active,
  .splitter:focus-visible {
    background: var(--accent);
  }

  .splitter:focus-visible {
    outline-offset: 0;
  }
</style>
