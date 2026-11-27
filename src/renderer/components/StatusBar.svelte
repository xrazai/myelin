<script lang="ts">
  import type { VaultInfo } from '../../shared/ipc';
  import { learning } from '../activity';

  let { vault, unsaved }: { vault: VaultInfo; unsaved: string[] } = $props();
</script>

<footer>
  <span class="vault" title={vault.root}>{vault.name}</span>
  <!-- Also covers a failed save of a note that is not on screen. -->
  <span class="unsaved" role="status">{unsaved.length > 0 ? `Not saved: ${unsaved.join(', ')}` : ''}</span>
  <!-- The `learning` indicator: anything that calls `learning.begin()` or `.pulse()` lights it. -->
  <span class={['learning', { active: $learning }]} role="status">
    <span class="dot" aria-hidden="true"></span>
    {$learning ?? ''}
  </span>
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
    font-size: 12px;
    color: var(--text-muted);
  }

  .unsaved {
    flex: 1;
    overflow: hidden;
    color: var(--text);
    font-weight: 600;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vault {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .learning {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
  }

  .learning.active {
    color: var(--learning);
  }

  .dot {
    width: 7px;
    height: 7px;
    background: var(--divider);
    border-radius: 50%;
  }

  .active .dot {
    background: var(--learning);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.75);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .active .dot {
      animation: none;
    }
  }

  @media (forced-colors: active) {
    .dot {
      forced-color-adjust: none;
      background: GrayText;
    }

    .active .dot {
      background: CanvasText;
    }
  }
</style>
