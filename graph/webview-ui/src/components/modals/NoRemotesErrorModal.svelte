<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    onClose: () => void;
    onAddRemote: () => void;
  }

  let { onClose, onAddRemote }: Props = $props();
</script>

<Modal title={t('common.error')} {onClose}>
  <p class="modal-desc">{t('toolbar.noRemotes')}</p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={onAddRemote}>{t('toolbar.addRemote')}</button>
  </div>
</Modal>
