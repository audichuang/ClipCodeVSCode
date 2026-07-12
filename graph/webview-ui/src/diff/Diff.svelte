<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { diffStore } from './diff-store.svelte';
  import { postStageHunk } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import FileDiffView from '../components/commit/FileDiffView.svelte';

  const store = diffStore;
  // Default side-by-side; own the toggle locally (PrView pattern) so we can pass
  // diffMode + hideModeToggle to FileDiffView while still letting the user flip.
  let mode = $state<'inline' | 'side-by-side'>('side-by-side');
</script>

<div class="diff-app-root">
  {#if !store.diff}
    <p class="empty">{t('file.openChanges')}</p>
  {:else}
    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}
    <div class="mode-bar">
      <span class="side-badge {store.side}">{store.side === 'staged' ? 'Staged' : 'Unstaged'}</span>
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => { mode = 'inline'; }}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => { mode = 'side-by-side'; }}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <FileDiffView
      diff={store.diff}
      staged={store.side === 'staged'}
      diffMode={mode}
      hideModeToggle
      onStageHunk={({ hunkIndex }) => postStageHunk(hunkIndex)}
    />
  {/if}
</div>

<style>
  .diff-app-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    color: var(--vscode-foreground);
  }
  .empty { padding: 16px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  .banner {
    display: flex; align-items: center; gap: 6px; margin: 6px 12px; padding: 4px 8px;
    border-radius: 4px; font-size: 12px; font-family: var(--vscode-font-family);
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }
  .mode-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family); flex-shrink: 0;
  }
  .side-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .diff-mode-toggle { display: flex; gap: 2px; background: rgba(128,128,128,0.15); border-radius: 3px; padding: 1px; }
  .diff-mode-toggle button {
    padding: 2px 8px; font-size: 0.75em; border-radius: 2px;
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer;
  }
  .diff-mode-toggle button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style>
