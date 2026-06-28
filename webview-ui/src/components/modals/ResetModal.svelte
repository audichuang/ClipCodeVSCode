<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    hash: string;
    branchName?: string;
    defaultMode?: 'soft' | 'mixed' | 'hard';
    onConfirm: (mode: 'soft' | 'mixed' | 'hard') => void;
    onClose: () => void;
  }

  let { hash, branchName, defaultMode = defaultsStore.current.reset.mode, onConfirm, onClose }: Props = $props();

  // Seed from the resolved default once. We intentionally do NOT keep this in
  // sync with defaultMode afterwards: that prop's default resolves to a
  // reactive store value, so a settings push while the modal is open would
  // re-run the sync effect and clobber the mode the user just picked. The modal
  // remounts per open, so a fresh default is applied each time anyway.
  // svelte-ignore state_referenced_locally
  let resetMode = $state<'soft' | 'mixed' | 'hard'>(defaultMode);
</script>

<Modal title={t('reset.modalTitle')} {onClose}>
  <p class="modal-desc">{t('reset.desc')}</p>
  <div class="modal-context-card">
    {#if branchName}
      <span use:tooltip={branchName} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{branchName}</span></span>
      <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    {/if}
    <span use:tooltip={hash} class="modal-pill modal-pill--target"><i class="codicon codicon-git-commit"></i><span class="modal-pill-text">{hash.substring(0, 7)}</span></span>
  </div>
  <div class="modal-form-group">
    <div class="modal-field-label">{t('reset.resetType')}</div>
    <ColorSelect
      options={[
        { value: 'soft',  label: t('reset.softOption'),  color: '#4caf50', flag: '--soft' },
        { value: 'mixed', label: t('reset.mixedOption'), color: '#ff9800', flag: '--mixed' },
        { value: 'hard',  label: t('reset.hardOption'),  color: '#f44336', warning: t('reset.hardWarning'), flag: '--hard' },
      ]}
      value={resetMode}
      onChange={(v) => { resetMode = v as typeof resetMode; }}
    />
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={() => { onConfirm(resetMode); onClose(); }}>
      {t('reset.resetBtn')}
    </button>
  </div>
</Modal>
