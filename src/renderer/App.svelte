<script lang="ts">
  import { onMount } from 'svelte';
  import type { VaultInfo } from '../shared/ipc';
  import { errorMessage } from './error-message';
  import { learning, trackIndexing } from './activity';
  import Launcher from './components/Launcher.svelte';
  import Workspace from './components/Workspace.svelte';

  let vault = $state.raw<VaultInfo | null>(null);
  /** The index is syncing. Tracked here: it starts before the workspace is mounted. */
  let indexing = $state(false);
  $effect(() => window.myelin.onIndexing((active) => (indexing = active)));
  /** While the last vault is being reopened, so the launcher does not flash. */
  let starting = $state(true);
  /** Why the last vault did not reopen. */
  let notice = $state('');

  // On start only: switching vaults goes to the launcher and stays there.
  onMount(() => {
    window.myelin
      .reopenVault()
      .then(
        (last) => (vault = last),
        (reason: unknown) => (notice = `Could not reopen the last vault. ${errorMessage(reason)}`),
      )
      .finally(() => (starting = false));
  });

  function leave() {
    notice = '';
    vault = null;
  }

  // Here, not in the workspace: indexing starts before the workspace is mounted.
  $effect(() => trackIndexing(window.myelin, learning));
</script>

{#if vault}
  {#key vault.root}
    <Workspace {vault} {indexing} onswitch={leave} />
  {/key}
{:else if !starting}
  <Launcher {notice} onopen={(opened) => (vault = opened)} />
{/if}
