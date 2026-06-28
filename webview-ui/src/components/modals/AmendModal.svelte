<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';
  import { shortenRef } from '../../lib/utils/git-ref';

  interface Props {
    hash: string;
    subject: string;
    message: string;
    isPushed: boolean;
    onClose: () => void;
    onAmend: (opts: { message?: string; keepMessage: boolean; resetDate: boolean; resetAuthor: boolean; only: boolean; pushAfter: boolean }) => void;
  }

  let { hash, subject, message, isPushed, onClose, onAmend }: Props = $props();
  let pushAfter = $state(defaultsStore.current.amend.pushAfter);

  // Independent options; "keep message" defaults on (message field read-only).
  let keepMessage = $state(defaultsStore.current.amend.keepMessage);
  let resetDate = $state(defaultsStore.current.amend.resetDate);
  let resetAuthor = $state(defaultsStore.current.amend.resetAuthor);
  // --only: amend message/metadata without folding the staged changes in.
  let only = $state(defaultsStore.current.amend.only);
  // Prefill with the HEAD message; the modal remounts per open so capturing the
  // initial prop value is intentional (untrack documents that to svelte-check).
  let editedMessage = $state(untrack(() => message));

  const canAmend = $derived(keepMessage || editedMessage.trim().length > 0);

  // Live count of staged files (what an amend folds in). Refreshes whenever the
  // index changes — e.g. the user stages/unstages in the SCM view we opened.
  let stagedCount = $state<number | null>(null);
  onMount(() => {
    const vscode = getVsCodeApi();
    const request = () => vscode.postMessage({ type: 'getUncommittedDiff' });
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'uncommittedDiffData') {
        stagedCount = (msg.payload?.staged ?? []).length;
      } else if (msg?.type === 'repoChanged') {
        request();
      }
    };
    window.addEventListener('message', handler);
    request();
    return () => window.removeEventListener('message', handler);
  });

  function submit() {
    if (!canAmend) return;
    onAmend({
      message: keepMessage ? undefined : editedMessage,
      keepMessage,
      resetDate,
      resetAuthor,
      only,
      pushAfter,
    });
  }
</script>

<Modal title={t('amend.title')} {onClose}>
  <div class="modal-context-card">
    <span use:tooltip={hash} class="modal-pill modal-pill--target">
      <i class="codicon codicon-git-commit"></i>
      <span class="modal-pill-text">{shortenRef(hash)}</span>
    </span>
  </div>

  <div class="modal-form-group">
    <label class="modal-field-label" for="amend-message">{t('amend.message')}</label>
    <textarea
      id="amend-message"
      class="modal-input amend-textarea"
      rows="8"
      bind:value={editedMessage}
      readonly={keepMessage}
    ></textarea>
  </div>

  <div class="modal-form-group amend-options">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={keepMessage} />
      <span>{t('amend.keepMessage')}</span>
      <span class="modal-flag-badge">--no-edit</span>
    </label>
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={resetDate} />
      <span>{t('amend.resetDate')}</span>
      <span class="modal-flag-badge">--date=now</span>
    </label>
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={resetAuthor} />
      <span>{t('amend.resetAuthor')}</span>
      <span class="modal-flag-badge">--reset-author</span>
    </label>
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={only} />
      <span>{t('amend.only')}</span>
      <span class="modal-flag-badge">--only</span>
    </label>
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={pushAfter} />
      <span>{t('amend.pushAfter')}</span>
      <span class="modal-flag-badge">--force-with-lease</span>
    </label>
  </div>

  {#if isPushed}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t('amend.pushedWarning')}</span>
    </p>
  {:else if pushAfter}
    <p class="modal-warning" role="alert">
      <i class="codicon codicon-warning"></i>
      <span>{@html t('amend.pushAfterWarning')}</span>
    </p>
  {/if}

  <div class="form-actions">
    <div
      class="staged-status"
      class:is-warning={!only && stagedCount === 0}
      class:is-success={!only && (stagedCount ?? 0) > 0}
    >
      {#if only}
        <i class="codicon codicon-info"></i>
        <span>{t('amend.onlyNote')}</span>
      {:else if stagedCount === null}
        <span class="spinner"></span>
        <span>{t('amend.checkingStaged')}</span>
      {:else if stagedCount === 0}
        <i class="codicon codicon-warning"></i>
        <span>{t('amend.stagedNone')}</span>
      {:else}
        <i class="codicon codicon-check modal-status-check"></i>
        <span>{t('amend.stagedIncluded', { count: String(stagedCount) })}</span>
      {/if}
    </div>
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={submit} disabled={!canAmend}>{t('amend.amend')}</button>
  </div>
</Modal>

<style>
  .amend-textarea {
    width: 100%;
    min-height: 9em;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    /* Keep the message scrollable so a long kept message can be read; a
       disabled textarea would block wheel/scrollbar interaction. */
    overflow-y: auto;
  }

  /* "Keep message" mode: not editable, but still readable and scrollable. */
  .amend-textarea:read-only {
    cursor: default;
    opacity: 0.85;
  }

  /* Space the stacked option checkboxes; they share one form group, so add the
     gap here instead of wrapping each in its own (as the other modals do). */
  .amend-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .staged-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: inherit;
    color: var(--text-secondary);
    margin-right: auto;
  }
  .staged-status.is-warning { color: #f0a020; }
  .staged-status.is-success { color: #4caf50; }
</style>
