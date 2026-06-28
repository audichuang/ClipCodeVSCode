<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';

  interface Props {
    /** Commits to apply, ordered oldest→newest (the order git replays them). */
    commits: string[];
    branch: string;
    onClose: () => void;
    onCherryPick: (options: { noCommit: boolean; pushAfter: boolean }) => void;
  }

  let { commits, branch, onClose, onCherryPick }: Props = $props();
  let noCommit = $state(defaultsStore.current.cherryPick.noCommit);
  let pushAfter = $state(defaultsStore.current.cherryPick.pushAfter);
  let cherryPickBtn: HTMLButtonElement | undefined = $state();

  // Display newest→oldest to match the graph's top-down ordering.
  const displayCommits = $derived([...commits].reverse());

  onMount(() => { cherryPickBtn?.focus(); });
</script>

<Modal title={t('cherryPickMultiple.title')} {onClose}>
  <p class="modal-desc">{t('cherryPickMultiple.desc', { count: String(commits.length), branch })}</p>

  <div class="cp-commit-list">
    {#each displayCommits as hash (hash)}
      <span use:tooltip={hash} class="modal-pill modal-pill--target">
        <i class="codicon codicon-git-commit"></i>
        <span class="modal-pill-text">{hash.substring(0, 7)}</span>
      </span>
    {/each}
  </div>

  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={noCommit} />
      <span>{t('cherryPick.noCommit')}</span>
    </label>
  </div>
  {#if !noCommit}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={pushAfter} />
        <span>{t('cherryPick.pushAfter')}</span>
      </label>
    </div>
  {/if}

  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" bind:this={cherryPickBtn} onclick={() => onCherryPick({ noCommit, pushAfter: !noCommit && pushAfter })}>{t('cherryPick.cherryPick')}</button>
  </div>
</Modal>

<style>
  .cp-commit-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 9em;
    overflow-y: auto;
    margin-bottom: 12px;
  }
</style>
