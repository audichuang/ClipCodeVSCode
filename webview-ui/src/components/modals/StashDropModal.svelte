<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    message: string;
    onClose: () => void;
    onDrop: () => void;
  }

  let { message, onClose, onDrop }: Props = $props();
</script>

<Modal title={t('stashDrop.title')} {onClose}>
  <p class="modal-desc">{t('stashDrop.confirm', { message })}</p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" onclick={onDrop}>{t('sidebar.drop')}</button>
  </div>
</Modal>
