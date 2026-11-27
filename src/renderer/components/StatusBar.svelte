<script lang="ts">
  import { learning } from '../activity';
  import { LINK_PULSE_EVENT } from '../editor/link-pulse';
  import { formatLinkSummary, formatWordSummary, type NoteMetrics } from '../editor/note-metrics';

  const PULSE_DURATION_MS = 1400;

  let {
    metrics = null,
    hasActiveNote = false,
    unsaved,
  }: {
    metrics?: NoteMetrics | null;
    hasActiveNote?: boolean;
    unsaved: string[];
  } = $props();

  let pulseLabel = $state<string | null>(null);
  let pulseKey = $state(0);

  // One-shot warm-ivory confirmation when a saved note adds a new `[[link]]`.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPulse = () => {
      pulseKey += 1;
      pulseLabel = 'Link added';
      clearTimeout(timer);
      timer = setTimeout(() => {
        pulseLabel = null;
      }, PULSE_DURATION_MS);
    };
    window.addEventListener(LINK_PULSE_EVENT, onPulse);
    return () => {
      window.removeEventListener(LINK_PULSE_EVENT, onPulse);
      clearTimeout(timer);
    };
  });

  const working = $derived($learning !== null);
  const indicatorLabel = $derived($learning ?? pulseLabel ?? 'Vault synced');
</script>

<footer>
  <div class="group metrics">
    {#if metrics}
      <span>{formatWordSummary(metrics)}</span>
      <span class="sep" aria-hidden="true"></span>
      <span>{formatLinkSummary(metrics.links)}</span>
    {/if}
  </div>

  <div class="group right">
    <!-- Also covers a failed save of a note that is not on screen. -->
    {#if unsaved.length > 0}
      <span class="unsaved" role="status">Not saved: {unsaved.join(', ')}</span>
      <span class="sep" aria-hidden="true"></span>
    {:else if hasActiveNote}
      <span class="saved">Saved</span>
      <span class="sep" aria-hidden="true"></span>
    {/if}

    <!-- Continuous animation only while background work runs; link pulse plays once and rests. -->
    {#key pulseKey}
      <span class={['learning', { working, pulsing: !working && pulseLabel !== null }]} role="status">
        <span class="dot" aria-hidden="true"></span>
        <span>{indicatorLabel}</span>
      </span>
    {/key}
  </div>
</footer>

<style>
  footer {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    height: 100%;
    padding: 0 12px;
    background: var(--bg-panel);
    border-top: 1px solid var(--divider);
    font-size: 11.5px;
    color: var(--text-muted);
    user-select: none;
  }

  .group {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
  }

  .metrics {
    flex: 0 1 auto;
    overflow: hidden;
    white-space: nowrap;
  }

  .right {
    flex: 0 1 auto;
    justify-content: flex-end;
  }

  .sep {
    flex: none;
    width: 1px;
    height: 10px;
    background: var(--divider);
  }

  .unsaved {
    overflow: hidden;
    color: var(--learning);
    font-weight: 560;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .saved {
    flex: none;
    color: var(--text-muted);
  }

  .learning {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    transition: color var(--t-base) ease;
  }

  .learning.working,
  .learning.pulsing {
    color: var(--learning);
  }

  .dot {
    width: 6.5px;
    height: 6.5px;
    background: color-mix(in srgb, var(--accent) 55%, var(--divider));
    border-radius: 50%;
    transition: background-color var(--t-base) ease;
  }

  .working .dot {
    background: var(--learning);
    animation: work-pulse 1.2s ease-in-out infinite;
  }

  .pulsing .dot {
    background: var(--learning);
    box-shadow: 0 0 8px color-mix(in srgb, var(--learning) 60%, transparent);
    animation: synapse-beat 850ms var(--ease-out) 1;
  }

  @keyframes work-pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.75);
    }
  }

  @keyframes synapse-beat {
    0% {
      transform: scale(1);
    }
    40% {
      transform: scale(1.45);
    }
    100% {
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .working .dot,
    .pulsing .dot {
      animation: none;
    }
  }

  @media (forced-colors: active) {
    .dot {
      forced-color-adjust: none;
      background: GrayText;
    }

    .working .dot,
    .pulsing .dot {
      background: CanvasText;
    }
  }
</style>
