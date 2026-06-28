<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    index: number;
    message: string;
    paths: string[];
    onClose: () => void;
    onRestore: () => void;
  }

  let { index, message, paths, onClose, onRestore }: Props = $props();
  const label = $derived(message || `stash@{${index}}`);
</script>

<Modal title={t('stashRestore.title')} {onClose}>
  <p class="modal-desc">{@html t('stashRestore.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={label} class="modal-pill modal-pill--stash"><i class="codicon codicon-archive"></i><span class="modal-pill-text">{label}</span></span>
  </div>
  <ul class="restore-file-list">
    {#each paths as p}
      <li use:tooltip={p}><i class="codicon codicon-file"></i><span class="restore-file-name">{p}</span></li>
    {/each}
  </ul>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={onRestore}>{t('stashRestore.restore')}</button>
  </div>
</Modal>

<style>
  .restore-file-list {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    max-height: 160px;
    overflow-y: auto;
    font-size: 12px;
  }
  .restore-file-list li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    color: var(--text-secondary);
  }
  .restore-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
