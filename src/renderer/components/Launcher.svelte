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
  <h1 class="prose">Myelin</h1>
  <p class="tagline">A vault of Markdown notes that learns from how you write and navigate.</p>
  <div class="choices">
    <button disabled={busy} onclick={() => choose('createVault')}>
      <strong>Create a new vault</strong>
      <span>Pick the folder where it will be saved.</span>
    </button>
    <button disabled={busy} onclick={() => choose('openVault')}>
      <strong>Open an existing vault</strong>
      <span>Pick a folder with your notes.</span>
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

  h1 {
    margin: 0;
    font-size: 40px;
    font-weight: 500;
  }

  .tagline {
    margin: 8px 0 32px;
    color: var(--text-muted);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(360px, 100%);
  }

  button {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 18px;
    text-align: left;
    background: var(--bg-panel);
    border: 1px solid var(--divider);
    border-radius: 8px;
    cursor: pointer;
  }

  button:hover:enabled {
    border-color: var(--accent);
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  button span {
    color: var(--text-muted);
  }

  .error {
    max-width: 480px;
    min-height: 3em;
    margin: 20px 0 0;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
