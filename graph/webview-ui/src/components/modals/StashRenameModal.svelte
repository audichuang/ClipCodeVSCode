<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    index: number;
    initialMessage: string;
    onClose: () => void;
    onRename: (message: string) => void;
  }

  let { index, initialMessage, onClose, onRename }: Props = $props();
  let newMessage = $state(untrack(() => initialMessage));
  const canSubmit = $derived(newMessage.trim().length > 0);
  const stashRef = untrack(() => `stash@{${index}}`);

  function submit() {
    if (canSubmit) onRename(newMessage);
  }
</script>

<Modal title={t('stashRename.title')} {onClose}>
  <div class="modal-context-card">
    <span use:tooltip={stashRef} class="modal-pill modal-pill--stash"><i class="codicon codicon-archive"></i><span class="modal-pill-text">{stashRef}</span></span>
  </div>
  <div class="modal-form-group">
    <label class="modal-field-label" for="stash-rename-input">{t('stashRename.newMessage')}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="stash-rename-input" class="modal-input" type="text" bind:value={newMessage} autofocus
      onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" disabled={!canSubmit} onclick={submit}>{t('stashRename.rename')}</button>
  </div>
</Modal>
