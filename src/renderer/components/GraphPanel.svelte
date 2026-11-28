<script lang="ts">
  // Mounts the graph's two stacked canvases; `graph-view.ts` does the rest.
  import { onMount } from 'svelte';
  import { LINK_PULSE_EVENT, type LinkPulse } from '../editor/link-pulse';
  import { graphLook } from '../graph-look';
  import { createGraphView, type GraphView } from '../graph-view';
  import { NOTE_HOVER_EVENT } from '../note-hover';

  let { onopen }: { onopen: (path: string) => void } = $props();

  let canvas: HTMLCanvasElement;
  let labelCanvas: HTMLCanvasElement;
  let view: GraphView | null = null;
  let failed = $state('');

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
</div>

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

  p {
    position: relative;
    margin: 0;
    padding: 6px 12px;
    color: var(--text-muted);
  }
</style>
