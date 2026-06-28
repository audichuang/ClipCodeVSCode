<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    upstream: string;
    currentBranch: string;
    onClose: () => void;
    onPull: (options: { rebase: boolean; stash: boolean }) => void;
  }

  let { upstream, currentBranch, onClose, onPull }: Props = $props();
  let rebase = $state(defaultsStore.current.pull.rebase);
  let stash = $state(defaultsStore.current.pull.stash);
</script>

<Modal title={t('pull.title')} {onClose}>
  <p class="modal-desc">{t('pull.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={upstream} class="modal-pill modal-pill--source"><i class="codicon codicon-cloud"></i><span class="modal-pill-text">{upstream}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    <span use:tooltip={currentBranch} class="modal-pill modal-pill--target"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{currentBranch}</span></span>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={rebase} />
      <span>{t('pull.rebase')}</span>
      <span class="modal-flag-badge">--rebase</span>
    </label>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={stash} />
      <span>{t('pull.stash')}</span>
      <span class="modal-flag-badge">--autostash</span>
    </label>
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={() => onPull({ rebase, stash })}>{t('pull.pull')}</button>
  </div>
</Modal>
