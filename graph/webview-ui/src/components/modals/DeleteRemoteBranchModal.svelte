<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    remote: string;
    branchName: string;
    onClose: () => void;
    onDelete: () => void;
  }

  let { remote, branchName, onClose, onDelete }: Props = $props();
</script>

<Modal title={t('deleteRemoteBranch.title')} {onClose}>
  <p class="modal-desc">{@html t('deleteRemoteBranch.confirm', { name: `${remote}/${branchName}` })}</p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" onclick={onDelete}>{t('sidebar.delete')}</button>
  </div>
</Modal>
