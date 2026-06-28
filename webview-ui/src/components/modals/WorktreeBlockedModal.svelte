<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    branchRef: string;
    displayPath: string;
    onClose: () => void;
    onOpenInNewWindow: () => void;
  }

  let { branchRef, displayPath, onClose, onOpenInNewWindow }: Props = $props();
</script>

<Modal title={t('checkout.worktreeBlockedTitle')} {onClose}>
  <p class="modal-desc">{t('checkout.worktreeBlockedDesc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={branchRef} class="modal-pill modal-pill--target"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{branchRef}</span></span>
  </div>
  <div class="modal-context-card">
    <i class="codicon codicon-worktree" style="color: var(--text-secondary);"></i>
    <span style="font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--text-secondary); word-break: break-all;">{displayPath}</span>
  </div>
  <div class="form-actions">
    <button class="primary" onclick={onOpenInNewWindow}>{t('checkout.openInNewWindow')}</button>
    <button onclick={onClose}>{t('common.close')}</button>
  </div>
</Modal>
