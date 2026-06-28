<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    files: string[];
    truncated?: boolean;
    children: Snippet;
  }

  let { files, truncated = false, children }: Props = $props();

  let open = $state(false);
  let triggerEl: HTMLSpanElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // Fixed-positioned panel; coordinates derived from the trigger rect.
  let posX = $state(0);
  let posY = $state(0);

  function clearCloseTimer() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }

  // Small grace period so the cursor can travel from the trigger to the
  // popover (e.g. to scroll a long list) without it closing underneath.
  function scheduleClose() {
    clearCloseTimer();
    closeTimer = setTimeout(() => { open = false; }, 150);
  }

  function show() {
    if (files.length === 0) { return; }
    clearCloseTimer();
    open = true;
  }

  // Position below the trigger once the panel is measurable; flip above when
  // there isn't room below. Runs after the panel mounts.
  $effect(() => {
    if (!open || !popoverEl || !triggerEl) { return; }
    const trect = triggerEl.getBoundingClientRect();
    const prect = popoverEl.getBoundingClientRect();
    const GAP = 6;
    let x = trect.left;
    let y = trect.bottom + GAP;
    if (y + prect.height > window.innerHeight - 4) { y = trect.top - prect.height - GAP; }
    if (x + prect.width > window.innerWidth - 4) { x = window.innerWidth - prect.width - 4; }
    posX = Math.max(4, x);
    posY = Math.max(4, y);
  });

  onMount(() => {
    const onBlur = () => { open = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { open = false; } };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      clearCloseTimer();
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="conflict-files-trigger"
  bind:this={triggerEl}
  onmouseenter={show}
  onmouseleave={scheduleClose}
>
  {@render children()}
</span>

{#if open && files.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="conflict-files-popover"
    bind:this={popoverEl}
    style="left: {posX}px; top: {posY}px;"
    onmouseenter={clearCloseTimer}
    onmouseleave={scheduleClose}
  >
    <div class="conflict-files-popover__header">
      {t('conflict.predictedFilesTitle')}
    </div>
    <ul class="conflict-files-popover__list">
      {#each files as file (file)}
        <li class="conflict-files-popover__item" use:tooltip={file}>{file}</li>
      {/each}
    </ul>
    {#if truncated}
      <div class="conflict-files-popover__truncated">{t('rebase.predictionTruncated')}</div>
    {/if}
  </div>
{/if}

<style>
  .conflict-files-trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .conflict-files-popover {
    position: fixed;
    z-index: 2100;
    background: var(--vscode-editorWidget-background, var(--bg-secondary));
    border: 1px solid var(--vscode-editorWidget-border, var(--border-color));
    border-radius: 6px;
    padding: 8px 10px;
    min-width: 220px;
    max-width: 420px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    font-size: calc(var(--vscode-font-size, 13px) - 1px);
    color: var(--text-primary);
    pointer-events: auto;
  }

  :global(body.vscode-light) .conflict-files-popover {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }

  .conflict-files-popover__header {
    font-size: 0.85em;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-secondary);
    margin-bottom: 6px;
    padding-bottom: 5px;
    border-bottom: 1px solid var(--border-color);
  }

  .conflict-files-popover__list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .conflict-files-popover__item {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
    line-height: 1.6;
    word-break: break-all;
    color: var(--text-secondary);
  }

  .conflict-files-popover__truncated {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 0.9em;
  }
</style>
