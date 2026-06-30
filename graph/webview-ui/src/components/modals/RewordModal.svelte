<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { shortenRef } from '../../lib/utils/git-ref';

  interface Props {
    hash: string;
    message: string;
    isHead: boolean;
    isPushed: boolean;
    onClose: () => void;
    onReword: (message: string) => void;
  }

  let { hash, message, isHead, isPushed, onClose, onReword }: Props = $props();

  // The modal remounts per open, so capturing the initial prop is intentional.
  let editedMessage = $state(untrack(() => message));

  const changed = $derived(editedMessage.trim().length > 0 && editedMessage.trim() !== message.trim());

  function submit() {
    if (!changed) return;
    onReword(editedMessage.trim());
  }

  function onKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter submits, matching the other message editors.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

<Modal title={t('reword.title')} {onClose}>
  <div class="modal-context-card">
    <span use:tooltip={hash} class="modal-pill modal-pill--target">
      <i class="codicon codicon-git-commit"></i>
      <span class="modal-pill-text">{shortenRef(hash)}</span>
    </span>
  </div>

  <div class="modal-form-group">
    <label class="modal-field-label" for="reword-message">{t('reword.message')}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      id="reword-message"
      class="modal-input reword-textarea"
      rows="8"
      autofocus
      bind:value={editedMessage}
      onkeydown={onKeydown}
    ></textarea>
  </div>

  {#if !isHead}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t(isPushed ? 'reword.rewritePushedWarning' : 'reword.rewriteWarning')}</span>
    </p>
  {:else if isPushed}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t('reword.headPushedWarning')}</span>
    </p>
  {/if}

  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={submit} disabled={!changed}>{t('reword.reword')}</button>
  </div>
</Modal>

<style>
  .reword-textarea {
    width: 100%;
    min-height: 9em;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
