<script lang="ts">
  import { t } from '../../lib/i18n/index.svelte';
  import type { DirtyOption } from '../../lib/utils/dirty-payload';

  interface Props {
    value: DirtyOption;
    onChange: (v: DirtyOption) => void;
    name: string;
  }

  let { value, onChange, name }: Props = $props();
</script>

<div class="modal-form-group">
  <div class="modal-field-label">{t('checkout.localChanges')}</div>
  <label class="modal-radio">
    <input type="radio" {name} value="stash" checked={value === 'stash'} onchange={() => onChange('stash')} />
    <span>{t('checkout.stash')}</span>
  </label>
  <label class="modal-radio">
    <input type="radio" {name} value="discard" checked={value === 'discard'} onchange={() => onChange('discard')} />
    <span>{t('checkout.discardAll')}</span>
  </label>
</div>
{#if value === 'discard'}
  <p class="modal-warning" role="alert">
    <i class="codicon codicon-warning"></i>
    <span>{@html t('checkout.discardWarning')}</span>
  </p>
{/if}
