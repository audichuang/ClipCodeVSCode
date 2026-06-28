<script lang="ts">
  import { uiStore } from '../../lib/stores/ui.svelte';
  import { commitStore } from '../../lib/stores/commits.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import CommitDetails from '../commit/CommitDetails.svelte';

  let commit = $derived(
    uiStore.selectedCommitHash
      ? commitStore.getCommit(uiStore.selectedCommitHash)
      : undefined
  );
  // Armed but fewer than 2 picked yet → prompt the user to select more.
  let armedHint = $derived(uiStore.multiSelectArmed && uiStore.selectedCommitHashes.length < 2);
</script>

<div class="bottom-panel">
  {#if uiStore.comparing}
    <CommitDetails />
  {:else if commit}
    <CommitDetails {commit} />
  {:else if armedHint}
    <div class="empty">{t('details.selectMoreCommits')}</div>
  {:else}
    <div class="empty">{t('details.selectCommit')}</div>
  {/if}
</div>

<style>
  .bottom-panel {
    height: 100%;
    overflow-y: auto;
    background: var(--bg-primary);
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
