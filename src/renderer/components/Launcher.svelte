<script lang="ts">
  import type { VaultInfo } from '../../shared/ipc';
  import { errorMessage } from '../error-message';

  let { onopen }: { onopen: (vault: VaultInfo) => void } = $props();

  let busy = $state(false);
  let error = $state('');

  async function choose(action: 'createVault' | 'openVault') {
    busy = true;
    error = '';
    try {
      // `null`: the folder dialog was canceled.
      const vault = await window.myelin[action]();
      if (vault) onopen(vault);
    } catch (reason) {
      const what = action === 'createVault' ? 'create' : 'open';
      error = `Could not ${what} the vault. ${errorMessage(reason)}`;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <div class="brand">
    <div class="mark" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 19c4-1 8-5 14-14-9 6-13 10-14 14Z" />
        <path d="M9.5 14.5 15 9" />
        <circle cx="17.5" cy="6.5" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="17.2" r="1.35" fill="currentColor" stroke="none" />
      </svg>
    </div>
    <h1 class="prose">Myelin</h1>
    <p class="tagline">A vault of Markdown notes that learns from how you write and navigate.</p>
  </div>
  <div class="choices">
    <button type="button" class="primary" disabled={busy} onclick={() => choose('openVault')}>
      <span class="choice-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
        </svg>
      </span>
      <span class="choice-copy">
        <strong>Open an existing vault</strong>
        <span>Pick a folder with your Markdown notes.</span>
      </span>
      <span class="arrow" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </span>
    </button>
    <button type="button" class="secondary" disabled={busy} onclick={() => choose('createVault')}>
      <span class="choice-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round">
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </span>
      <span class="choice-copy">
        <strong>Create a new vault</strong>
        <span>Choose a folder to initialize a fresh vault.</span>
      </span>
      <span class="arrow" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </span>
    </button>
  </div>
  <p class="error" role="alert">{error}</p>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 32px;
    text-align: center;
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: 16px;
    color: var(--accent);
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 12px;
    box-shadow: inset 0 1px 0 var(--hairline);
  }

  h1 {
    margin: 0;
    font-size: 38px;
    font-weight: 520;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }

  .tagline {
    max-width: 36ch;
    margin: 10px 0 32px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(380px, 100%);
  }

  button {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 14px 16px;
    text-align: left;
    border-radius: 9px;
    cursor: pointer;
    box-shadow: inset 0 1px 0 var(--hairline);
  }

  button.primary {
    background: var(--surface-elevated);
    border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--divider));
  }

  button.secondary {
    background: var(--bg-panel);
    border: 1px solid var(--divider);
  }

  button:hover:enabled {
    border-color: var(--accent);
    background: var(--surface-elevated);
  }

  button.primary:hover:enabled {
    background: color-mix(in srgb, var(--accent) 9%, var(--surface-elevated));
  }

  button:active:enabled {
    transform: scale(0.985);
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .choice-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 7px;
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    color: var(--text-muted);
    transition:
      color var(--t-fast) ease,
      border-color var(--t-fast) ease,
      background-color var(--t-fast) ease;
  }

  button.primary .choice-icon {
    color: var(--accent);
    background: var(--surface-active);
    border-color: color-mix(in srgb, var(--accent) 26%, transparent);
  }

  button:hover:enabled .choice-icon {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 36%, var(--divider));
  }

  .choice-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .choice-copy strong {
    font-weight: 560;
    color: var(--text);
  }

  .choice-copy span {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  .arrow {
    flex: none;
    color: var(--text-muted);
    opacity: 0.6;
    transition:
      transform var(--t-fast) var(--ease-out),
      opacity var(--t-fast) ease,
      color var(--t-fast) ease;
  }

  button:hover:enabled .arrow {
    color: var(--accent);
    opacity: 1;
    transform: translateX(2px);
  }

  .error {
    max-width: 480px;
    min-height: 3em;
    margin: 20px 0 0;
    overflow-wrap: anywhere;
    user-select: text;
  }

  @media (prefers-reduced-motion: reduce) {
    button:hover:enabled .arrow {
      transform: none;
    }
  }
</style>
