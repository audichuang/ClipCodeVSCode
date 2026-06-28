<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import DirtyChoice from '../common/DirtyChoice.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';
  import { dirtyPayload, type DirtyOption, type DirtyPayload } from '../../lib/utils/dirty-payload';

  interface Props {
    title: string;
    confirmLabel: string;
    onConfirm: (payload: DirtyPayload) => void;
    onClose: () => void;
  }

  let { title, confirmLabel, onConfirm, onClose }: Props = $props();

  // This modal is only shown when the tree is dirty, so the choice always maps
  // to a non-empty payload.
  let option = $state<DirtyOption>(defaultsStore.current.checkout.dirty === 'discard' ? 'discard' : 'stash');
  let confirmBtn: HTMLButtonElement | undefined = $state();

  onMount(() => { confirmBtn?.focus(); });

  function confirm() {
    onConfirm(dirtyPayload(option, true));
    onClose();
  }
</script>

<Modal {title} {onClose}>
  <DirtyChoice value={option} onChange={(v) => { option = v; }} name="dirty-action" />
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" bind:this={confirmBtn} onclick={confirm}>{confirmLabel}</button>
  </div>
</Modal>
