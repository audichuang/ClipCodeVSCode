<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    onClose: () => void;
    onSave: (message: string, includeUntracked: boolean, keepIndex: boolean) => void;
  }

  let { onClose, onSave }: Props = $props();
  let message = $state('');
  let includeUntracked = $state(defaultsStore.current.stashSave.includeUntracked);
  let keepIndex = $state(defaultsStore.current.stashSave.keepIndex);

  function submit() {
    onSave(message, includeUntracked, keepIndex);
  }
</script>

<Modal title={t('stashSave.title')} {onClose}>
  <div class="modal-form-group">
    <label class="modal-field-label" for="stash-save-input">{t('stashSave.message')}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="stash-save-input" class="modal-input" type="text" bind:value={message} placeholder={t('stashSave.placeholder')} autofocus
      onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={includeUntracked} />
      <span>{t('stash.includeUntracked')}</span>
      <span class="modal-flag-badge">--include-untracked</span>
    </label>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={keepIndex} />
      <span>{t('stash.keepIndex')}</span>
      <span class="modal-flag-badge">--keep-index</span>
    </label>
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={submit}>{t('stash.stash')}</button>
  </div>
</Modal>
