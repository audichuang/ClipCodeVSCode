<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    tagName: string;
    remotes: Array<{ name: string }>;
    initialRemote: string;
    onClose: () => void;
    onPush: (remote: string) => void;
  }

  let { tagName, remotes, initialRemote, onClose, onPush }: Props = $props();
  let selectedRemote = $state(untrack(() => initialRemote));
</script>

<Modal title={t('pushTag.title')} {onClose}>
  <p class="modal-desc">{t('pushTag.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={tagName} class="modal-pill modal-pill--tag"><i class="codicon codicon-tag"></i><span class="modal-pill-text">{tagName}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    {#if remotes.length > 1}
      <i class="codicon codicon-cloud" style="color: var(--text-secondary);"></i>
      <ColorSelect
        options={remotes.map(r => ({ value: r.name, label: r.name, color: '' }))}
        value={selectedRemote}
        onChange={(v) => { selectedRemote = v; }}
        showDot={false}
      />
    {:else}
      <span use:tooltip={selectedRemote} class="modal-pill modal-pill--target"><i class="codicon codicon-cloud"></i><span class="modal-pill-text">{selectedRemote}</span></span>
    {/if}
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={() => onPush(selectedRemote)}>{t('pushTag.push')}</button>
  </div>
</Modal>
