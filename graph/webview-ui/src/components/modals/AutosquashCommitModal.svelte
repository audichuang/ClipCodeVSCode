<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { shortenRef } from '../../lib/utils/git-ref';

  interface Props {
    /** Whether to create a `fixup!` or `squash!` marker commit. */
    mode: 'fixup' | 'squash';
    /** Target commit hash the marker is attached to. */
    commit: string;
    /** Target commit subject — used to preview the generated message. */
    subject: string;
    onClose: () => void;
    onConfirm: () => void;
  }

  let { mode, commit, subject, onClose, onConfirm }: Props = $props();

  // The message git generates for `commit --fixup|--squash`: the target's subject
  // line prefixed with `fixup! ` / `squash! `. This mirrors git's behaviour for a
  // normal target. If the target is itself already a `fixup!`/`squash!` commit, git
  // strips the prefix back to the original subject; the preview shows the common
  // case and may differ in that edge case.
  const prefix = $derived(mode === 'fixup' ? 'fixup!' : 'squash!');
  const previewMessage = $derived(`${prefix} ${subject}`);

  // Live count of staged files (what the marker commit captures). Refreshes
  // whenever the index changes — e.g. the user stages/unstages in the SCM view
  // we opened alongside this modal.
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

  const canConfirm = $derived((stagedCount ?? 0) > 0);
  const title = $derived(t(mode === 'fixup' ? 'fixup.title' : 'autosquash.title'));
  const desc = $derived(t(mode === 'fixup' ? 'fixup.desc' : 'autosquash.desc'));
  const confirmLabel = $derived(t('autosquash.button'));
</script>

<Modal {title} {onClose}>
  <p class="modal-desc">{desc}</p>
  <div class="modal-context-card">
    <span use:tooltip={commit} class="modal-pill modal-pill--target">
      <i class="codicon codicon-git-commit"></i>
      <span class="modal-pill-text">{shortenRef(commit)}</span>
    </span>
  </div>

  <div class="preview">
    <span class="preview-label">{t('autosquash.preview')}:</span>
    <div class="preview-message">{previewMessage}</div>
  </div>

  <div class="form-actions">
    <div
      class="staged-status"
      class:is-warning={stagedCount === 0}
      class:is-success={(stagedCount ?? 0) > 0}
    >
      {#if stagedCount === null}
        <span class="spinner"></span>
        <span>{t('fixup.checkingStaged')}</span>
      {:else if stagedCount === 0}
        <i class="codicon codicon-warning"></i>
        <span>{t('fixup.stagedNone')}</span>
      {:else}
        <i class="codicon codicon-check modal-status-check"></i>
        <span>{t('fixup.stagedIncluded', { count: String(stagedCount) })}</span>
      {/if}
    </div>
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" onclick={onConfirm} disabled={!canConfirm}>{confirmLabel}</button>
  </div>
</Modal>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
  }
  .preview-label {
    color: var(--text-secondary);
    font-size: inherit;
  }
  .preview-message {
    max-height: 120px;
    overflow-y: auto;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
    border: 1px solid var(--border, rgba(127, 127, 127, 0.2));
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: pre-wrap;
    word-break: break-word;
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
