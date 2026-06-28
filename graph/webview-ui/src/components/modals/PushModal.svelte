<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  type ForceMode = 'none' | 'with-lease' | 'force';

  interface Props {
    branchName: string;
    hasUpstream: boolean;
    upstream: string;
    remotes: Array<{ name: string }>;
    initialRemote: string;
    onClose: () => void;
    onPush: (options: { forceMode: ForceMode; setUpstream: boolean; remote: string; allTags: boolean }) => void;
  }

  let { branchName, hasUpstream, upstream, remotes, initialRemote, onClose, onPush }: Props = $props();
  let selectedRemote = $state(untrack(() => initialRemote));
  let forceMode = $state<ForceMode>(defaultsStore.current.push.force);
  let setUpstream = $state(defaultsStore.current.push.setUpstream);
  let allTags = $state(defaultsStore.current.push.allTags);

  const pushTarget = $derived(hasUpstream ? upstream : `${selectedRemote}/${branchName}`);
</script>

<Modal title={t('push.title')} {onClose}>
  <p class="modal-desc">{t('push.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={branchName} class="modal-pill modal-pill--source"><i class="codicon codicon-git-branch"></i><span class="modal-pill-text">{branchName}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    {#if hasUpstream}
      <span use:tooltip={pushTarget} class="modal-pill modal-pill--target"><i class="codicon codicon-cloud"></i><span class="modal-pill-text">{pushTarget}</span></span>
    {:else if remotes.length > 1}
      <i class="codicon codicon-cloud" style="color: var(--text-secondary);"></i>
      <ColorSelect
        options={remotes.map(r => ({ value: r.name, label: `new (${r.name}/${branchName})`, color: '' }))}
        value={selectedRemote}
        onChange={(v) => { selectedRemote = v; }}
        showDot={false}
      />
    {:else}
      <span use:tooltip={t('push.new', { target: pushTarget })} class="modal-pill modal-pill--target"><i class="codicon codicon-cloud"></i><span class="modal-pill-text">{t('push.new', { target: pushTarget })}</span></span>
    {/if}
  </div>
  {#if !hasUpstream}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={setUpstream} />
        <span>{t('push.createTracking')}</span>
      </label>
    </div>
  {/if}
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={allTags} />
      <span>{t('push.pushAllTags')}</span>
    </label>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox"
        checked={forceMode === 'with-lease'}
        onchange={() => { forceMode = forceMode === 'with-lease' ? 'none' : 'with-lease'; }} />
      <span>{t('push.forceWithLease')}</span>
      <span class="modal-flag-badge">--force-with-lease</span>
    </label>
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox modal-checkbox--danger">
      <input type="checkbox"
        checked={forceMode === 'force'}
        onchange={() => { forceMode = forceMode === 'force' ? 'none' : 'force'; }} />
      <span>{t('push.force')}</span>
      <span class="modal-flag-badge">--force</span>
    </label>
  </div>
  {#if forceMode === 'with-lease'}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('push.forceWithLeaseWarning')}</span></p>
  {:else if forceMode === 'force'}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('push.forceWarning')}</span></p>
  {/if}
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={() => onPush({ forceMode, setUpstream, remote: selectedRemote, allTags })}>{t('push.push')}</button>
  </div>
</Modal>
