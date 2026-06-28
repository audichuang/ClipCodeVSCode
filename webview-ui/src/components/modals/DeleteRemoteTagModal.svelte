<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    tagName: string;
    onClose: () => void;
    onDelete: () => void;
  }

  let { tagName, onClose, onDelete }: Props = $props();
</script>

<Modal title={t('deleteRemoteTag.title')} {onClose}>
  <p class="modal-desc">{@html t('deleteRemoteTag.confirm', { name: tagName })}</p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" onclick={onDelete}>{t('sidebar.delete')}</button>
  </div>
</Modal>
