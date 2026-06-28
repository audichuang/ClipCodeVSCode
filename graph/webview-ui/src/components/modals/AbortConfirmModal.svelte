<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    operation: string;
    onClose: () => void;
    onConfirm: () => void;
  }

  let { operation, onClose, onConfirm }: Props = $props();
</script>

<Modal title={t('conflict.abortTitle')} {onClose}>
  <p class="modal-desc">{@html t('conflict.abortConfirm', { operation })}</p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" onclick={onConfirm}>{t('conflict.abort')}</button>
  </div>
</Modal>
