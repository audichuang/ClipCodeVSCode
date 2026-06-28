<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ConflictFilesPopover from '../common/ConflictFilesPopover.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    commit: string;
    branch: string;
    onClose: () => void;
    onRevert: (options: { noCommit: boolean; pushAfter: boolean }) => void;
  }

  let { commit, branch, onClose, onRevert }: Props = $props();
  let noCommit = $state(defaultsStore.current.revert.noCommit);
  let pushAfter = $state(defaultsStore.current.revert.pushAfter);
  let revertBtn: HTMLButtonElement | undefined = $state();
  let conflictPrediction = $state<{ hasConflict: boolean; files: string[] } | null>(null);

  onMount(() => {
    revertBtn?.focus();
    const vscode = getVsCodeApi();
    const requestId = `rv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    vscode.postMessage({ type: 'predictConflicts', payload: { ours: 'HEAD', theirs: commit + '^', mergeBase: commit, requestId } });
    const handler = (event: MessageEvent) => {
      if (event.data.type !== 'conflictPrediction') { return; }
      if (event.data.payload?.requestId !== requestId) { return; }
      conflictPrediction = event.data.payload;
      window.removeEventListener('message', handler);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });
</script>

<Modal title={t('revert.title')} {onClose}>
  <p class="modal-desc">{t('revert.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={commit} class="modal-pill modal-pill--danger"><i class="codicon codicon-git-commit"></i><span class="modal-pill-text">{commit.substring(0, 7)}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    <span use:tooltip={branch} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{branch}</span></span>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={noCommit} />
      <span>{t('revert.noCommit')}</span>
    </label>
  </div>
  {#if !noCommit}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={pushAfter} />
        <span>{t('revert.pushAfter')}</span>
      </label>
    </div>
  {/if}
  <div class="form-actions">
    <div class="conflict-status" class:is-warning={conflictPrediction?.hasConflict} class:is-success={conflictPrediction !== null && !conflictPrediction?.hasConflict}>
      {#if conflictPrediction === null}
        <span class="spinner"></span>
        <span>{t('revert.checkingConflicts')}</span>
      {:else if conflictPrediction.hasConflict}
        <ConflictFilesPopover files={conflictPrediction.files}>
          <i class="codicon codicon-warning"></i>
          <span>{t('revert.conflictWarning', { count: String(conflictPrediction.files.length) })}</span>
        </ConflictFilesPopover>
      {:else}
        <i class="codicon codicon-check modal-status-check"></i>
        <span>{t('revert.noConflict')}</span>
      {/if}
    </div>
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" bind:this={revertBtn} onclick={() => onRevert({ noCommit, pushAfter: !noCommit && pushAfter })}>{t('revert.revert')}</button>
  </div>
</Modal>

<style>
  .conflict-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: inherit;
    margin-right: auto;
    color: var(--text-secondary);
  }

  .conflict-status.is-warning { color: #f0a020; }
  .conflict-status.is-success { color: #4caf50; }
</style>
