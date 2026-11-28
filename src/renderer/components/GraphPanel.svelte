<script lang="ts">
  // Mounts the graph's two stacked canvases; `graph-view.ts` does the rest.
  import { onMount } from 'svelte';
  import { tick } from 'svelte';
  import type { ConstellationInfo } from '../constellation';
  import { LINK_PULSE_EVENT, type LinkPulse } from '../editor/link-pulse';
  import { graphLook } from '../graph-look';
  import { createGraphView, type GraphView } from '../graph-view';
  import { NOTE_HOVER_EVENT } from '../note-hover';
  import ConstellationCard from './ConstellationCard.svelte';

  let { onopen }: { onopen: (path: string) => void } = $props();

  let canvas: HTMLCanvasElement;
  let labelCanvas: HTMLCanvasElement;
  let view: GraphView | null = null;
  let failed = $state('');
  let hovered = $state.raw<ConstellationInfo | null>(null);
  let selected = $state.raw<ConstellationInfo | null>(null);
  let card = $state<ReturnType<typeof ConstellationCard>>();

  /** Glides to a note's node. */
  export function focus(path: string) {
    view?.focus(path);
  }

  async function select(constellation: ConstellationInfo) {
    selected = constellation;
    await tick();
    card?.focus();
  }

  /** From the card: the camera goes along. */
  function travel(id: number) {
    const next = view?.constellation(id);
    if (!next) return;
    view!.focusConstellation(id);
    void select(next);
  }

  /** Notes renamed or moved in the app keep their nodes. */
  export function renamed(moves: Iterable<readonly [string, string]>) {
    view?.renamed(moves);
  }

  onMount(() => {
    try {
      view = createGraphView({
        canvas,
        labelCanvas,
        api: window.myelin,
        ...graphLook(getComputedStyle(document.documentElement)),
        onopen: (path) => onopen(path),
        onhover: (constellation) => (hovered = constellation),
        onselect: (constellation) => void select(constellation),
        // The card stays current, and closes once its constellation is gone.
        onchange: () => {
          if (selected) selected = view?.constellation(selected.id) ?? null;
          hovered = null;
        },
        onerror: (message) => (failed = message),
      });
    } catch (error) {
      // No WebGL2, say: the rest of the workspace goes on.
      console.error('[graph] not started:', error);
      failed = error instanceof Error ? error.message : String(error);
    }
    const pulse = (event: Event) => view?.pulse((event as CustomEvent<LinkPulse>).detail);
    const hover = (event: Event) => view?.highlight((event as CustomEvent<string | null>).detail);
    window.addEventListener(LINK_PULSE_EVENT, pulse);
    window.addEventListener(NOTE_HOVER_EVENT, hover);
    return () => {
      window.removeEventListener(LINK_PULSE_EVENT, pulse);
      window.removeEventListener(NOTE_HOVER_EVENT, hover);
      view?.destroy();
      view = null;
    };
  });
</script>

<div class="graph">
  <canvas bind:this={canvas} aria-label="Graph of the notes and their links"></canvas>
  <canvas bind:this={labelCanvas} class="labels" aria-hidden="true"></canvas>
  {#if failed}
    <p role="alert">The graph cannot be shown. {failed}</p>
  {/if}
  {#if hovered}
    <div class="tip" aria-hidden="true">
      <strong>{hovered.name}</strong> <span>{hovered.size} notes</span>
      <div>{hovered.main.slice(0, 3).map((note) => note.title).join(' · ')}</div>
    </div>
  {/if}
</div>
{#if selected}
  <ConstellationCard
    bind:this={card}
    info={selected}
    onopen={(path) => onopen(path)}
    onselect={travel}
    onclose={() => (selected = null)}
  />
{/if}

<style>
  .graph {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }

  .labels {
    pointer-events: none;
  }

  .tip {
    position: absolute;
    top: 8px;
    left: 8px;
    max-width: calc(100% - 16px);
    padding: 6px 10px;
    font-size: 12px;
    background: var(--surface-elevated);
    border: 1px solid var(--divider);
    border-radius: 6px;
    pointer-events: none;
  }

  .tip span,
  .tip div {
    color: var(--text-muted);
  }

  p {
    position: relative;
    margin: 0;
    padding: 6px 12px;
    color: var(--text-muted);
  }
</style>
