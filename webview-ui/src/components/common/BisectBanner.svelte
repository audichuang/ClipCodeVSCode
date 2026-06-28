<script lang="ts">
  import { t } from '../../lib/i18n/index.svelte';
  import { getVsCodeApi } from '../../lib/vscode-api';

  interface Props {
    message: string;
    onReset: () => void;
  }

  let { message, onReset }: Props = $props();

  const vscode = getVsCodeApi();

  // Parse bisect result message. Git output is forced to English via LC_ALL=C
  // in GitService.exec, so a single English match is sufficient regardless of UI locale.
  const isFinished = $derived(message.includes('is the first bad commit'));

  // Extract remaining steps from message like "Bisecting: 3 revisions left to test after this (roughly 2 steps)"
  const remainingSteps = $derived.by(() => {
    const match = message.match(/roughly (\d+) step/);
    return match ? match[1] : null;
  });

  // Extract current commit hash from message
  const currentHash = $derived.by(() => {
    const match = message.match(/\[([a-f0-9]{7,40})\]/);
    return match ? match[1] : null;
  });

  // Extract culprit commit hash when finished
  const culpritHash = $derived.by(() => {
    if (!isFinished) return null;
    const match = message.match(/^([a-f0-9]{7,40})/m);
    return match ? match[1] : null;
  });

  // Extract commit message summary of culprit
  const culpritSummary = $derived.by(() => {
    if (!isFinished) return null;
    const lines = message.split('\n');
    // Look for indented lines after Date: (git log format)
    let pastHeaders = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Author:') || trimmed.startsWith('Date:') || trimmed.startsWith('commit ') || trimmed.startsWith(':')) {
        pastHeaders = true;
        continue;
      }
      if (trimmed === '' && pastHeaders) continue;
      if (pastHeaders && trimmed.length > 0 && !trimmed.includes('is the first bad commit')) {
        return trimmed;
      }
    }
    return null;
  });

  function markGood() {
    vscode.postMessage({ type: 'bisectGood', payload: {} });
  }

  function markBad() {
    vscode.postMessage({ type: 'bisectBad', payload: {} });
  }

  function skip() {
    vscode.postMessage({ type: 'bisectSkip' });
  }
</script>

<div class="bisect-banner banner-card" class:finished={isFinished}>
  <div class="bisect-header">
    <i class="codicon codicon-search"></i>
    <span class="bisect-title">
      {#if isFinished}
        {t('bisect.banner.found')}
      {:else}
        {t('bisect.banner.title')}
        {#if remainingSteps}
          <span class="bisect-remaining"> - {t('bisect.banner.remaining', { count: remainingSteps })}</span>
        {/if}
      {/if}
    </span>
  </div>

  {#if isFinished && culpritHash}
    <div class="bisect-culprit">
      <i class="codicon codicon-git-commit"></i>
      <span class="bisect-hash">{culpritHash.substring(0, 7)}</span>
      {#if culpritSummary}
        <span class="bisect-summary">{culpritSummary}</span>
      {/if}
    </div>
  {:else if currentHash}
    <div class="bisect-current">
      <span class="bisect-current-label">{t('bisect.banner.current')}</span>
      <span class="bisect-hash">{currentHash.substring(0, 7)}</span>
    </div>
  {/if}

  <div class="bisect-actions">
    {#if !isFinished}
      <button class="banner-btn success" onclick={markGood}>
        <i class="codicon codicon-check"></i>
        {t('bisect.banner.good')}
      </button>
      <button class="banner-btn danger" onclick={markBad}>
        <i class="codicon codicon-close"></i>
        {t('bisect.banner.bad')}
      </button>
      <button class="banner-btn" onclick={skip}>
        {t('bisect.banner.skip')}
      </button>
    {/if}
    <button class="banner-btn bisect-reset" onclick={onReset}>
      {t('bisect.banner.reset')}
    </button>
  </div>
</div>

<style>
  .bisect-banner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px;
    background: rgba(33, 150, 243, 0.08);
    border: 1px solid rgba(33, 150, 243, 0.3);
  }

  .bisect-banner.finished {
    background: rgba(76, 175, 80, 0.08);
    border-color: rgba(76, 175, 80, 0.3);
  }

  .bisect-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .bisect-header i {
    font-size: 14px;
    color: #2196f3;
  }

  .bisect-banner.finished .bisect-header i {
    color: #4caf50;
  }

  .bisect-title {
    font-size: inherit;
    font-weight: 600;
    color: var(--text-primary);
  }

  .bisect-remaining {
    font-weight: 400;
    color: var(--text-secondary);
  }

  .bisect-current {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: inherit;
    color: var(--text-secondary);
  }

  .bisect-culprit {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: inherit;
    padding: 6px 10px;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 4px;
  }

  .bisect-culprit i {
    color: var(--text-secondary);
  }

  .bisect-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 600;
    color: var(--text-primary);
  }

  .bisect-summary {
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bisect-actions {
    display: flex;
    gap: 6px;
  }

  .bisect-actions :global(.banner-btn) {
    font-size: inherit;
  }

  .bisect-reset {
    margin-left: auto;
  }

  /* ---- Light theme overrides ---- */
  :global(body.vscode-light) .bisect-banner {
    background: rgba(21, 101, 192, 0.07);
    border-color: rgba(21, 101, 192, 0.3);
  }

  :global(body.vscode-light) .bisect-banner.finished {
    background: rgba(46, 125, 50, 0.07);
    border-color: rgba(46, 125, 50, 0.3);
  }

  :global(body.vscode-light) .bisect-header i {
    color: #1565c0;
  }

  :global(body.vscode-light) .bisect-banner.finished .bisect-header i {
    color: #2e7d32;
  }

</style>
