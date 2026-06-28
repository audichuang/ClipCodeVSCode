<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    name: string;
    message?: string;
    onClose: () => void;
  }

  let { name, message, onClose }: Props = $props();
</script>

<Modal title={t('graph.showTagDetails', { tag: name })} {onClose}>
  <div class="tag-details">
    <div class="tag-details-row">
      <span class="tag-details-label">{t('graph.tagLabel')}:</span>
      <span class="tag-details-value"><span use:tooltip={name} class="modal-pill modal-pill--tag"><i class="codicon codicon-tag"></i><span class="modal-pill-text"> {name}</span></span></span>
    </div>
    {#if message}
      <div class="tag-details-row tag-details-message-row">
        <span class="tag-details-label">{t('createTag.message')}</span>
        <textarea class="tag-details-message" readonly rows="6">{message}</textarea>
      </div>
    {/if}
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.close')}</button>
  </div>
</Modal>

<style>
  .tag-details {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px 12px;
    padding: 4px 0 8px;
    align-items: center;
  }

  .tag-details-row {
    display: contents;
  }

  .tag-details-message-row .tag-details-label {
    align-self: start;
    padding-top: 6px;
  }

  .tag-details-label {
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .tag-details-value {
    display: flex;
    align-items: center;
    min-width: 0;
    font-size: 13px;
  }

  .tag-details-message {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--vscode-input-border, var(--border-color));
    border-radius: 3px;
    color: var(--text-primary);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    padding: 6px 8px;
    line-height: 1.5;
    outline: none;
  }
</style>
