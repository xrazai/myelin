<script lang="ts">
  import { tick } from 'svelte';
  import type { MenuItem } from '../new-item';

  /** A context menu at `x`, `y`. `onclose(true)`: dismissed, so the focus goes back. */
  let {
    items,
    x,
    y,
    onpick,
    onclose,
  }: {
    items: MenuItem[];
    x: number;
    y: number;
    onpick: (id: MenuItem['id']) => void;
    onclose: (dismissed: boolean) => void;
  } = $props();

  let menu = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);

  const buttons = () => [...(menu?.querySelectorAll('button') ?? [])];

  // Placed again if another click moves it.
  $effect(() => {
    left = x;
    top = y;
    void tick().then(() => {
      if (!menu) return;
      left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 4));
      top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 4));
      buttons()[0]?.focus();
    });
  });

  function onkeydown(event: KeyboardEvent) {
    // Shortcuts still reach the window.
    if (event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (at + 1) % all.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + all.length) % all.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onclose(true);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    all[next]?.focus();
  }

  function onoutside(event: Event) {
    if (!menu?.contains(event.target as Node)) onclose(false);
  }
</script>

<svelte:window onpointerdowncapture={onoutside} onblur={() => onclose(false)} onresize={() => onclose(false)} />

<div
  class="menu"
  role="menu"
  tabindex="-1"
  bind:this={menu}
  style:left="{left}px"
  style:top="{top}px"
  {onkeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each items as item (item.id)}
    <button type="button" role="menuitem" tabindex="-1" onclick={() => onpick(item.id)}>{item.label}</button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    padding: 4px;
    background: var(--surface-elevated);
    border: 1px solid var(--divider);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
  }

  button {
    padding: 5px 10px;
    color: var(--text);
    background: none;
    border: 0;
    border-radius: 5px;
    font-size: 12.8px;
    text-align: left;
    cursor: pointer;
  }

  button:hover,
  button:focus {
    background: var(--surface-hover);
  }

  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
