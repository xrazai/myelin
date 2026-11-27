<script lang="ts">
  import type { VaultInfo } from '../shared/ipc';
  import { learning, trackIndexing } from './activity';
  import Launcher from './components/Launcher.svelte';
  import Workspace from './components/Workspace.svelte';

  let vault = $state.raw<VaultInfo | null>(null);

  // Here, not in the workspace: indexing starts before the workspace is mounted.
  $effect(() => trackIndexing(window.myelin, learning));
</script>

{#if vault}
  <Workspace {vault} />
{:else}
  <Launcher onopen={(opened) => (vault = opened)} />
{/if}
