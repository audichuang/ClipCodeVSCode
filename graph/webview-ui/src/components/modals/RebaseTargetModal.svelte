<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import DirtyChoice from '../common/DirtyChoice.svelte';
  import { requestDirtyState } from '../../lib/utils/dirty-check';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';
  import { dirtyPayload, type DirtyOption, type DirtyPayload } from '../../lib/utils/dirty-payload';

  interface Props {
    branches: string[];
    currentBranch: string;
    base: string;
    onConfirm: (branch: string, payload: DirtyPayload) => void;
    onClose: () => void;
  }

  let { branches, currentBranch, base, onConfirm, onClose }: Props = $props();

  // The modal mounts fresh per open with a fixed `branches` list, so capturing
  // the initial value is intentional (untrack documents that to svelte-check).
  let selectedBranch = $state(untrack(() => branches[0] ?? ''));
  const isShared = $derived(branches.length > 1);

  let dirty = $state(false);
  let option = $state<DirtyOption>(defaultsStore.current.checkout.dirty === 'discard' ? 'discard' : 'stash');
  let confirmBtn: HTMLButtonElement | undefined = $state();

  onMount(() => {
    confirmBtn?.focus();
    let cancelled = false;
    requestDirtyState().then(d => { if (!cancelled) dirty = d; }).catch(() => {});
    return () => { cancelled = true; };
  });

  function confirm() {
    onConfirm(selectedBranch, dirtyPayload(option, dirty));
    onClose();
  }
</script>

<Modal title={t('rebaseTarget.title')} {onClose}>
  <p class="modal-desc">{t('rebaseTarget.desc')}</p>
  <div class="modal-context-card">
    {#if currentBranch}
      <span use:tooltip={currentBranch} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{currentBranch}</span></span>
      <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    {/if}
    <span use:tooltip={selectedBranch} class="modal-pill modal-pill--target"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{selectedBranch}</span></span>
  </div>

  {#if branches.length > 1}
    <div class="modal-form-group">
      <div class="modal-field-label">{t('rebaseTarget.selectBranch')}</div>
      <ColorSelect
        showDot={false}
        options={branches.map(b => ({ value: b, label: b, color: '', icon: 'codicon-git-branch' }))}
        value={selectedBranch}
        onChange={(v) => { selectedBranch = v; }}
      />
    </div>
  {/if}

  {#if dirty}
    <DirtyChoice value={option} onChange={(v) => { option = v; }} name="rebase-target-dirty" />
  {/if}

  {#if isShared}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t('rebaseTarget.sharedWarning')}</span>
    </p>
  {/if}

  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" bind:this={confirmBtn} onclick={confirm}>{t('rebaseTarget.checkout')}</button>
  </div>
</Modal>
