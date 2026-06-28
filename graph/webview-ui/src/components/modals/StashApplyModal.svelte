<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    index: number;
    message: string;
    drop: boolean;
    targetBranch: string;
    onClose: () => void;
    onApply: () => void;
  }

  let { index, message, drop, targetBranch, onClose, onApply }: Props = $props();
  const label = $derived(message || `stash@{${index}}`);
</script>

<Modal title={drop ? t('stashPop.title') : t('stashApply.title')} {onClose}>
  <p class="modal-desc">{@html drop ? t('stashPop.desc') : t('stashApply.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={label} class="modal-pill modal-pill--stash"><i class="codicon codicon-archive"></i><span class="modal-pill-text">{label}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    <span use:tooltip={targetBranch} class="modal-pill modal-pill--target"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{targetBranch}</span></span>
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={onApply}>{drop ? t('stashPop.pop') : t('stashApply.apply')}</button>
  </div>
</Modal>
