<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { diffStore, type DiffSide } from './diff-store.svelte';
  import { postStageHunk, postStageLines, postOpenSide } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import { getVsCodeApi } from '../lib/vscode-api';
  import FileDiffView from '../components/commit/FileDiffView.svelte';

  const store = diffStore;
  /* SNIPCODE-HOOK start: D5 default inline + remember the user's last choice */
  // SBS is the least capable mode (no hunk header, no Stage Hunk, no line
  // drag-select — see FileDiffView's SBS branch), so it should never be the
  // silent default. Restore the user's last choice from webview state (this
  // panel's own acquireVsCodeApi(), unrelated to any other webview) so a
  // switch persists across reopening the Diff tab.
  type DiffState = { diffMode?: 'inline' | 'side-by-side' };
  let mode = $state<'inline' | 'side-by-side'>((getVsCodeApi().getState() as DiffState | undefined)?.diffMode ?? 'inline');
  function setMode(next: 'inline' | 'side-by-side'): void {
    mode = next;
    getVsCodeApi().setState({ ...(getVsCodeApi().getState() as DiffState | undefined), diffMode: next });
  }
  /* SNIPCODE-HOOK end */

  // Per-side collapse; reset when the shown file changes. Keyed on repo + path so
  // the same relative path in a different repo doesn't inherit the prior collapse.
  let collapsed = $state<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false });
  let lastKey = '';
  $effect(() => {
    const key = `${store.repoPath}\u0000${store.file}`;
    if (key !== lastKey) {
      lastKey = key;
      collapsed = { staged: false, unstaged: false };
    }
  });

  // Section presence keys off diff !== null (NOT empty hunks — a binary/rename
  // side is non-null with empty hunks and must still show its section).
  const sections = $derived(
    ([
      { side: 'staged' as DiffSide, diff: store.stagedDiff, label: t('details.staged') },
      { side: 'unstaged' as DiffSide, diff: store.unstagedDiff, label: t('details.unstaged') },
    ]).filter((s) => s.diff !== null)
  );
</script>

<div class="diff-app-root">
  {#if !store.loaded}
    <p class="empty">{t('file.openChanges')}</p>
  <!-- SNIPCODE-HOOK start: Batch D clear stale body during navigation -->
  {:else if store.loading}
    <p class="empty">{t('file.loadingChanges')}</p>
  <!-- SNIPCODE-HOOK end -->
  {:else}
    <!-- The banner renders in the empty state too: a failed fetch (null sides +
         error) must not read as an affirmative "No changes". -->
    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}
    {#if sections.length === 0}
      {#if !store.error}
        <p class="empty">{t('file.noChanges')}</p>
      {/if}
    {:else}
    <div class="mode-bar">
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => setMode('inline')}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => setMode('side-by-side')}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <div class="sections">
      <!-- SNIPCODE-HOOK start: Batch B image component identity -->
      {#each sections as section (`${store.repoPath}\u0000${store.generation}\u0000${section.side}`)}
        <section class="diff-section">
          <!-- A row, not one button: the open-diff action must not toggle collapse
               (and a button can't nest inside a button). -->
          <div class="section-header">
            <button
              class="section-toggle"
              aria-expanded={!collapsed[section.side]}
              onclick={() => { collapsed[section.side] = !collapsed[section.side]; }}
            >
              <span class="codicon {collapsed[section.side] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>
              <span class="side-badge {section.side}">{section.label}</span>
            </button>
            <button
              class="section-open-btn"
              title={t('file.openFullDiff')}
              aria-label={`${section.label}: ${t('file.openFullDiff')}`}
              onclick={() => postOpenSide(section.side)}
            >
              <span class="codicon codicon-diff"></span>
            </button>
          </div>
          {#if !collapsed[section.side]}
            <FileDiffView
              diff={section.diff!}
              staged={section.side === 'staged'}
              stacked
              diffMode={mode}
              hideModeToggle
              stageBusy={store.busy}
              imageRepoPath={store.repoPath}
              imageGeneration={store.generation}
              onStageHunk={({ hunkIndex }) => postStageHunk(section.side, hunkIndex)}
              onStageLines={({ hunkIndex, lineIndices }) => postStageLines(section.side, hunkIndex, lineIndices)}
            />
          {/if}
        </section>
      {/each}
      <!-- SNIPCODE-HOOK end -->
    </div>
    {/if}
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
    display: flex; align-items: center;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
    position: sticky; top: 0; z-index: 3;
  }
  .section-toggle {
    flex: 1; display: flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: none; cursor: pointer; text-align: left;
    background: transparent;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
  }
  .section-open-btn {
    display: flex; align-items: center; padding: 4px 10px;
    border: none; cursor: pointer; background: transparent;
    color: var(--vscode-descriptionForeground);
  }
  .section-open-btn:hover { color: var(--vscode-foreground); }
  .side-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }

  /* Each FileDiffView renders its own sticky filename toolbar. In this unified
     single-file view that is redundant (the panel title already names the file)
     and it would sticky-overlap the Staged/Unstaged section header. Hide it —
     the section header is the only sticky bar we want per section. */
  .diff-section :global(.diff-toolbar) { display: none; }
</style>
