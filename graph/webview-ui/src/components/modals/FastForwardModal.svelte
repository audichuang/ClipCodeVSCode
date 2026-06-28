<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    localBranch: string;
    remote: string;
    /** Whether the local branch is the one currently checked out. */
    isCurrentBranch: boolean;
    onClose: () => void;
    onConfirm: (noCheckout: boolean) => void;
  }

  let { localBranch, remote, isCurrentBranch, onClose, onConfirm }: Props = $props();

  // For a non-current branch, default to updating it in place (no checkout) —
  // that's the whole point of doing this from another branch. The modal is
  // remounted each time it opens, so capturing the initial prop value is correct.
  let noCheckout = $state(untrack(() => !isCurrentBranch));
</script>

<Modal title={noCheckout ? t('fastForward.titleNoCheckout') : t('fastForward.title')} {onClose}>
  <p class="modal-desc">{noCheckout ? t('fastForward.descNoCheckout') : t('fastForward.desc')}</p>
  {#if !noCheckout}
    <div class="modal-context-card">
      <span class="modal-label">{t('fastForward.switchTo')}</span>
      <span use:tooltip={localBranch} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{localBranch}</span></span>
    </div>
  {:else}
    <div class="modal-context-card">
      <span class="modal-label">{t('fastForward.update')}</span>
      <span use:tooltip={localBranch} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{localBranch}</span></span>
    </div>
  {/if}
  <div class="modal-context-card">
    <span class="modal-label">{t('fastForward.fastForwardTo')}</span>
    <span use:tooltip={remote} class="modal-pill modal-pill--target"><i class="codicon codicon-cloud"></i><span class="modal-pill-text">{remote}</span></span>
  </div>
  {#if !isCurrentBranch}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={noCheckout} />
        <span>{t('fastForward.noCheckout')}</span>
      </label>
    </div>
  {/if}
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={() => onConfirm(noCheckout)}>{noCheckout ? t('fastForward.titleNoCheckout') : t('fastForward.title')}</button>
  </div>
</Modal>
