<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    remotes: Array<{ name: string }>;
    initialRemote: string;
    onClose: () => void;
    onFetch: (remote: string | undefined) => void;
  }

  let { remotes, initialRemote, onClose, onFetch }: Props = $props();
  let selectedRemote = $state(untrack(() => initialRemote));
  let allRemotes = $state(defaultsStore.current.fetch.allRemotes);

  function submit() {
    onFetch(allRemotes ? undefined : selectedRemote);
  }
</script>

<Modal title={t('fetch.title')} {onClose}>
  <p class="modal-desc">{t('fetch.desc')}</p>
  <div class="modal-form-group">
    <div class="modal-field-label">{t('fetch.remote')}</div>
    <ColorSelect
      options={remotes.map(r => ({ value: r.name, label: r.name, color: '' }))}
      value={selectedRemote}
      onChange={(v) => { selectedRemote = v; }}
      showDot={false}
    />
  </div>
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={allRemotes} />
      <span>{t('fetch.allRemotes')}</span>
    </label>
  </div>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={submit}>{t('fetch.fetch')}</button>
  </div>
</Modal>
