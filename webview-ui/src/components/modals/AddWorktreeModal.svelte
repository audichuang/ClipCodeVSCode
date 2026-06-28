<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { branchStore } from '../../lib/stores/branches.svelte';
  import { validateGitRefName } from '../../lib/utils/git-ref';

  interface Props {
    defaultPath?: string;
    startPoint?: string;
    onClose: () => void;
    onAdd: (path: string, branch?: string, newBranch?: string) => void;
  }

  type WorktreeMode = 'existing' | 'new';

  let { defaultPath = '', startPoint, onClose, onAdd }: Props = $props();

  const localBranches = $derived(branchStore.localBranches.map(b => b.name));
  const checkedOutBranches = $derived(new Set(branchStore.worktrees.map(w => w.branch).filter(Boolean)));
  const availableExistingBranches = $derived(localBranches.filter(b => !checkedOutBranches.has(b)));
  const startAtOptions = $derived(localBranches.length > 0 ? localBranches : ['HEAD']);
  let existingBranch = $state('');
  // svelte-ignore state_referenced_locally
  let startAt = $state(startPoint ?? branchStore.currentBranch?.name ?? 'HEAD');
  // svelte-ignore state_referenced_locally
  let mode = $state<WorktreeMode>(startPoint ? 'new' : 'existing');
  let branchName = $state('');
  // svelte-ignore state_referenced_locally
  let location = $state(defaultPath);
  let branchInput: HTMLInputElement | undefined = $state();

  const sourceRef = $derived(startAt || 'HEAD');
  const folderName = $derived(mode === 'new' ? branchName.trim() : existingBranch);

  function worktreeFolder(basePath: string, name: string): string {
    const sanitized = name.replace(/[\\/]+/g, '-');
    if (!basePath) return sanitized;
    return basePath.replace(/[\\/]+$/, '') + '/' + sanitized;
  }

  $effect(() => {
    if (!startAtOptions.includes(startAt)) {
      startAt = startAtOptions[0] ?? 'HEAD';
    }
    if (!existingBranch || !availableExistingBranches.includes(existingBranch)) {
      existingBranch = availableExistingBranches[0] ?? '';
    }
    if (mode === 'existing' && availableExistingBranches.length === 0) {
      mode = 'new';
    }
  });

  $effect(() => {
    if (defaultPath && folderName) {
      location = worktreeFolder(defaultPath, folderName);
    } else if (defaultPath) {
      location = defaultPath;
    }
  });

  onMount(() => { if (mode === 'new') branchInput?.focus(); });

  const refError = $derived(mode === 'new' && branchName.trim() !== '' ? validateGitRefName(branchName.trim()) : null);
  const canSubmit = $derived(
    location.trim() !== ''
      && (mode === 'new'
        ? branchName.trim() !== '' && !refError
        : existingBranch !== '')
  );
  function handleSubmit() {
    if (!canSubmit) return;
    if (mode === 'new') {
      onAdd(location.trim(), sourceRef, branchName.trim());
    } else {
      onAdd(location.trim(), existingBranch);
    }
  }
</script>

<Modal title={t('worktree.addTitle')} {onClose}>
  <div class="modal-form-group mode-options" role="radiogroup" aria-label={t('worktree.mode')}>
    <label class="modal-radio">
      <input type="radio" name="worktree-mode" value="existing" bind:group={mode} disabled={availableExistingBranches.length === 0} />
      <span>{t('worktree.useExisting')}</span>
    </label>
    <label class="modal-radio">
      <input type="radio" name="worktree-mode" value="new" bind:group={mode} />
      <span>{t('worktree.createNewBranch')}</span>
    </label>
  </div>

  {#if mode === 'existing'}
    <div class="modal-form-group">
      <div class="modal-field-row">
        <div class="modal-field-label">{t('worktree.existingBranch')}</div>
        <ColorSelect
          options={availableExistingBranches.map(b => ({ value: b, label: b, color: '' }))}
          value={existingBranch}
          onChange={(v) => { existingBranch = v; }}
          showDot={false}
        />
      </div>
    </div>
  {:else}
    <div class="modal-form-group">
      <div class="modal-field-row">
        <div class="modal-field-label">{t('worktree.startAt')}</div>
        <ColorSelect
          options={startAtOptions.map(b => ({ value: b, label: b, color: '' }))}
          value={startAt}
          onChange={(v) => { startAt = v; }}
          showDot={false}
        />
      </div>
    </div>

    <div class="modal-form-group">
      <div class="modal-field-row">
        <label class="modal-field-label" for="wt-branch">{t('worktree.branchName')}</label>
        <input id="wt-branch" class="modal-input" type="text" bind:value={branchName} bind:this={branchInput} placeholder={t('worktree.branchPlaceholder')} onkeydown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }} />
      </div>
    </div>
  {/if}

  <div class="modal-form-group">
    <div class="modal-field-row">
      <label class="modal-field-label" for="wt-location">{t('worktree.location')}</label>
      <input id="wt-location" class="modal-input location-input" type="text" bind:value={location} />
    </div>
  </div>

  {#if refError}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i>{t(refError)}</p>
  {/if}
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" disabled={!canSubmit} onclick={handleSubmit}>{t('worktree.add')}</button>
  </div>
</Modal>

<style>
  .location-input {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--text-secondary);
  }

  .mode-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
