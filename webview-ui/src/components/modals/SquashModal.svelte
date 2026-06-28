<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import type { Commit } from '../../lib/types';
  import { buildDefaultSquashMessage, buildSquashTodos } from '../../lib/utils/squash';

  interface Props {
    /** Selected commits ordered oldest→newest (from getSquashChain). */
    chain: Commit[];
    /** Parent of the oldest selected commit — the rebase base. */
    base: string;
    /** True when any selected commit is already on the upstream. */
    hasPushedCommits: boolean;
    onClose: () => void;
  }

  let { chain, base, hasPushedCommits, onClose }: Props = $props();

  const vscode = getVsCodeApi();

  // The modal remounts per open, so capturing the initial combined message once
  // is intentional (untrack documents that to svelte-check).
  let editedMessage = $state(untrack(() => buildDefaultSquashMessage(chain)));

  // The full base..HEAD range; needed because `rebase -i base` replays every
  // commit in that range, so commits newer than the selection must be kept as
  // `pick`. Fetched on mount so it is ready by the time the user confirms.
  let rebaseCommits = $state<Commit[] | null>(null);

  const canSquash = $derived(rebaseCommits !== null && editedMessage.trim().length > 0);

  onMount(() => {
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === 'rebaseCommitsData' && msg.payload?.base === base) {
        rebaseCommits = msg.payload.commits as Commit[];
      }
    }
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'getRebaseCommits', payload: { base } });
    return () => window.removeEventListener('message', handleMessage);
  });

  function submit() {
    if (!canSquash || !rebaseCommits) return;
    const selectedHashes = chain.map(c => c.hash);
    const todos = buildSquashTodos(rebaseCommits, selectedHashes, chain[0].hash, editedMessage);
    vscode.postMessage({ type: 'interactiveRebase', payload: { base, todos, squashCount: chain.length } });
    onClose();
  }
</script>

<Modal title={t('squash.title')} {onClose}>
  <p class="modal-desc">{t('squash.description', { count: String(chain.length) })}</p>

  <div class="squash-commit-list">
    {#each [...chain].reverse() as commit (commit.hash)}
      <div class="squash-commit-row">
        <span use:tooltip={commit.hash} class="modal-pill modal-pill--target">
          <i class="codicon codicon-git-commit"></i>
          <span class="modal-pill-text">{commit.abbreviatedHash}</span>
        </span>
        <span class="squash-commit-subject">{commit.subject}</span>
      </div>
    {/each}
  </div>

  <div class="modal-form-group">
    <label class="modal-field-label" for="squash-message">{t('squash.message')}</label>
    <textarea
      id="squash-message"
      class="modal-input squash-textarea"
      rows="8"
      bind:value={editedMessage}
    ></textarea>
  </div>

  {#if hasPushedCommits}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t('squash.pushedWarning')}</span>
    </p>
  {/if}

  <div class="form-actions">
    {#if rebaseCommits === null}
      <div class="squash-status">
        <span class="spinner"></span>
        <span>{t('squash.loading')}</span>
      </div>
    {/if}
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={submit} disabled={!canSquash}>{t('squash.squash')}</button>
  </div>
</Modal>

<style>
  .squash-commit-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 9em;
    overflow-y: auto;
    margin-bottom: 12px;
  }

  .squash-commit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .squash-commit-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .squash-textarea {
    width: 100%;
    min-height: 9em;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow-y: auto;
  }

  .squash-status {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    margin-right: auto;
  }
</style>
