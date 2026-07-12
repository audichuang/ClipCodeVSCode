<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { diffStore, type DiffSide } from './diff-store.svelte';
  import { postStageHunk, postStageLines } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import FileDiffView from '../components/commit/FileDiffView.svelte';

  const store = diffStore;
  // Default side-by-side; own the toggle locally (PrView pattern) so we can pass
  // diffMode + hideModeToggle to FileDiffView while still letting the user flip.
  // Shared across both sections.
  let mode = $state<'inline' | 'side-by-side'>('side-by-side');

  // Per-side collapse; reset when the file changes.
  let collapsed = $state<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false });
  let lastFile = '';
  $effect(() => {
    if (store.file !== lastFile) {
      lastFile = store.file;
      collapsed = { staged: false, unstaged: false };
    }
  });

  // Section presence keys off diff !== null (NOT empty hunks — a binary/rename
  // side is non-null with empty hunks and must still show its section).
  const sections = $derived(
    ([
      { side: 'staged' as DiffSide, diff: store.stagedDiff, label: 'Staged' },
      { side: 'unstaged' as DiffSide, diff: store.unstagedDiff, label: 'Unstaged' },
    ]).filter((s) => s.diff !== null)
  );
</script>

<div class="diff-app-root">
  {#if !store.loaded}
    <p class="empty">{t('file.openChanges')}</p>
  {:else if sections.length === 0}
    <p class="empty">{t('file.noChanges')}</p>
  {:else}
    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}
    <div class="mode-bar">
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => { mode = 'inline'; }}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => { mode = 'side-by-side'; }}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <div class="sections">
      {#each sections as section (section.side)}
        <section class="diff-section">
          <button
            class="section-header"
            aria-expanded={!collapsed[section.side]}
            onclick={() => { collapsed[section.side] = !collapsed[section.side]; }}
          >
            <span class="codicon {collapsed[section.side] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>
            <span class="side-badge {section.side}">{section.label}</span>
          </button>
          {#if !collapsed[section.side]}
            <FileDiffView
              diff={section.diff!}
              staged={section.side === 'staged'}
              stacked
              diffMode={mode}
              hideModeToggle
              stageBusy={store.busy}
              onStageHunk={({ hunkIndex }) => postStageHunk(section.side, hunkIndex)}
              onStageLines={({ hunkIndex, lineIndices }) => postStageLines(section.side, hunkIndex, lineIndices)}
            />
          {/if}
        </section>
      {/each}
    </div>
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
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family); flex-shrink: 0;
  }
  .diff-mode-toggle { display: flex; gap: 2px; background: rgba(128,128,128,0.15); border-radius: 3px; padding: 1px; }
  .diff-mode-toggle button {
    padding: 2px 8px; font-size: 0.75em; border-radius: 2px;
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer;
  }
  .diff-mode-toggle button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  /* The panel owns the scroll; each FileDiffView is `stacked` (flex:none, its own
     content height) so both sections form one long page instead of two half-height
     independently-scrolling boxes. */
  .sections { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .diff-section { display: flex; flex-direction: column; }
  .section-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: none; cursor: pointer; text-align: left;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
    position: sticky; top: 0; z-index: 3;
  }
  .side-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
</style>
