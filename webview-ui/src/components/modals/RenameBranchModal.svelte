<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { validateGitRefName } from '../../lib/utils/git-ref';

  interface Props {
    oldName: string;
    onClose: () => void;
    onRename: (newName: string) => void;
  }

  let { oldName, onClose, onRename }: Props = $props();
  let newName = $state(untrack(() => oldName));
  const refError = $derived(newName.trim() !== '' ? validateGitRefName(newName.trim()) : null);
  const canSubmit = $derived(newName.trim().length > 0 && newName !== oldName && !refError);

  function submit() {
    if (canSubmit) onRename(newName);
  }
</script>

<Modal title={t('renameBranch.title')} {onClose}>
  <div class="modal-context-card">
    <span use:tooltip={oldName} class="modal-pill modal-pill--target"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{oldName}</span></span>
  </div>
  <div class="modal-form-group">
    <label class="modal-field-label" for="rename-branch-input">{t('renameBranch.newName')}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="rename-branch-input" class="modal-input" type="text" bind:value={newName} autofocus
      onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
  </div>
  {#if refError}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i>{t(refError)}</p>
  {/if}
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" disabled={!canSubmit} onclick={submit}>{t('renameBranch.rename')}</button>
  </div>
</Modal>
