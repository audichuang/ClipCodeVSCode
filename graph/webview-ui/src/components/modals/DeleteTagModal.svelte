<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    tagName: string;
    hasRemote?: boolean;
    onClose: () => void;
    onDelete: (deleteRemote: boolean) => void;
  }

  let { tagName, hasRemote = false, onClose, onDelete }: Props = $props();
  let deleteRemote = $state(defaultsStore.current.deleteTag.deleteRemote);
</script>

<Modal title={t('deleteTag.title')} {onClose}>
  <p class="modal-desc">{@html t('deleteTag.confirm', { name: tagName })}</p>
  {#if hasRemote}
    <div class="modal-form-group">
      <label class="modal-checkbox modal-checkbox--danger">
        <input type="checkbox" bind:checked={deleteRemote} />
        <span>{t('deleteTag.deleteRemote')}</span>
      </label>
    </div>
  {/if}
  {#if hasRemote && deleteRemote}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('deleteTag.deleteRemoteWarning')}</span></p>
  {/if}
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <!-- SNIPCODE-HOOK start: R2 — destructive modal must not pre-focus its danger button (Enter-to-delete guard) -->
    <button class="danger-btn" onclick={() => onDelete(hasRemote && deleteRemote)}>{t('sidebar.delete')}</button>
    <!-- SNIPCODE-HOOK end -->
  </div>
</Modal>
