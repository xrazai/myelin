<script lang="ts">
  import type { VaultInfo } from '../shared/ipc';
  import Launcher from './components/Launcher.svelte';
  import Workspace from './components/Workspace.svelte';

  let vault = $state.raw<VaultInfo | null>(null);
</script>

{#if vault}
  <Workspace {vault} />
{:else}
  <Launcher onopen={(opened) => (vault = opened)} />
{/if}
