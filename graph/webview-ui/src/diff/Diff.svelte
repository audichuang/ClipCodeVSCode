<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { diffStore, type DiffSide } from './diff-store.svelte';
  import { postStageHunk, postStageLines, postOpenSide } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import { getVsCodeApi } from '../lib/vscode-api';
  import FileDiffView from '../components/commit/FileDiffView.svelte';
  import type { DiffData } from '../lib/types';

  /* SNIPCODE-HOOK start: D6/X2 file header — dir/base, status letter, +/- stats */
  function dirOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i + 1);
  }
  function baseOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? path : path.slice(i + 1);
  }
  // Derived from the parser's own header metadata (D3), not a tree-supplied
  // status — works today without any host/tree wiring. A rename beats
  // new/deleted (a renamed file can ALSO be marked new/deleted-looking by
  // git in edge cases, but oldPath is the authoritative signal here).
  function statusLetter(diff: DiffData): 'R' | 'A' | 'D' | 'M' {
    if (diff.oldPath) return 'R';
    if (diff.newFile) return 'A';
    if (diff.deletedFile) return 'D';
    return 'M';
  }
  function lineStats(diff: DiffData): { add: number; del: number } {
    let add = 0;
    let del = 0;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') add++;
        else if (line.type === 'delete') del++;
      }
    }
    return { add, del };
  }
  /* SNIPCODE-HOOK end */

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
    /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
    // Inline and SBS render entirely different DOM for "the same" hunk, so a
    // stale index/element reference from the other mode must not carry over.
    resetHunkNav();
    /* SNIPCODE-HOOK end */
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: ui/diff D10 sticky hunk header — measure the section
     header's real rendered height (varies with font-size/zoom) so the hunk
     header can stick just below it instead of a guessed pixel constant. */
  let sectionHeaderHeight = $state(0);
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
      /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
      resetHunkNav();
      /* SNIPCODE-HOOK end */
    }
  });

  /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
  // DOM-query based (PrView.svelte's pattern, PrView.svelte:387-395) rather
  // than plumbing hunk identity through FileDiffView's props: currentHunk is
  // a plain index into the flattened, currently-rendered hunk list. -1 means
  // "no jump made yet" so the first "next" lands on hunk 0 and "prev" at/above
  // index 0 is a no-op instead of wrapping.
  let sectionsEl = $state<HTMLElement | undefined>();
  let currentHunk = $state(-1);
  let currentHunkEl: HTMLElement | null = null;

  function resetHunkNav(): void {
    currentHunkEl?.classList.remove('current-hunk');
    currentHunkEl = null;
    currentHunk = -1;
  }

  function jumpHunk(dir: 1 | -1): void {
    const container = sectionsEl;
    if (!container) return;
    // Side-by-side renders every logical hunk twice (once per pane, scroll-
    // synced) - scope to .sbs-left so inline and SBS both yield one entry per
    // logical hunk.
    const hunks = [...container.querySelectorAll<HTMLElement>('.diff-hunk, .sbs-left .sbs-hunk')];
    if (hunks.length === 0) return;
    if (dir === 1) {
      currentHunk = Math.min(currentHunk + 1, hunks.length - 1);
    } else {
      if (currentHunk <= 0) return;
      currentHunk = currentHunk - 1;
    }
    currentHunkEl?.classList.remove('current-hunk');
    currentHunkEl = hunks[currentHunk] ?? null;
    currentHunkEl?.classList.add('current-hunk');
    currentHunkEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); jumpHunk(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); jumpHunk(-1); }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
  /* SNIPCODE-HOOK end */

  // Section presence keys off diff !== null (NOT empty hunks — a binary/rename
  // side is non-null with empty hunks and must still show its section).
  const sections = $derived(
    ([
      { side: 'staged' as DiffSide, diff: store.stagedDiff, label: t('details.staged') },
      { side: 'unstaged' as DiffSide, diff: store.unstagedDiff, label: t('details.unstaged') },
    ])
      .filter((s) => s.diff !== null)
      /* SNIPCODE-HOOK start: D6/X2 file header — dir/base, status letter, +/- stats */
      // Computed per SIDE, not one combined total: staged (HEAD->index) and
      // unstaged (index->working) are different baselines, so summing them
      // would double-count a line staged then edited again.
      .map((s) => ({ ...s, status: statusLetter(s.diff!), stats: lineStats(s.diff!) }))
      /* SNIPCODE-HOOK end */
  );

  /* SNIPCODE-HOOK start: D6/X2 file header — dir/base, status letter, +/- stats */
  const fileDir = $derived(dirOf(store.file));
  const fileBase = $derived(baseOf(store.file));
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: F4 header shows the old path for a rename+modify */
  // Either side's diff can carry oldPath (a file staged-then-modified after a
  // rename still has it on both) — the first one found is enough for display.
  const renameOldPath = $derived(sections.find((s) => s.diff?.oldPath)?.diff?.oldPath ?? null);
  /* SNIPCODE-HOOK end */
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
      <!-- SNIPCODE-HOOK start: D6/X2 file header — dir/base -->
      <!-- Diff tab hides FileDiffView's own toolbar (below), so this is the
           ONLY place the full path is visible; per-side status/± live on
           each section's badge instead (see .side-badge). -->
      <span class="mode-bar-file" title={store.file}>
        <!-- SNIPCODE-HOOK start: F4 header shows the old path for a rename+modify -->
        {#if renameOldPath}
          <span class="file-old-path">{renameOldPath}</span>
          <span class="file-rename-arrow">→</span>
        {/if}
        <!-- SNIPCODE-HOOK end -->
        {#if fileDir}<span class="file-dir">{fileDir}</span>{/if}
        <span class="file-base">{fileBase}</span>
      </span>
      <!-- SNIPCODE-HOOK end -->
      <!-- SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav -->
      <div class="hunk-nav">
        <button class="hunk-nav-btn" aria-label={t('diff.prevHunk')} title={`${t('diff.prevHunk')} (Alt+↑)`} onclick={() => jumpHunk(-1)}>
          <span class="codicon codicon-arrow-up"></span>
        </button>
        <button class="hunk-nav-btn" aria-label={t('diff.nextHunk')} title={`${t('diff.nextHunk')} (Alt+↓)`} onclick={() => jumpHunk(1)}>
          <span class="codicon codicon-arrow-down"></span>
        </button>
      </div>
      <!-- SNIPCODE-HOOK end -->
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => setMode('inline')}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => setMode('side-by-side')}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <!-- SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav -->
    <div class="sections" bind:this={sectionsEl}>
    <!-- SNIPCODE-HOOK end -->
      <!-- SNIPCODE-HOOK start: Batch B image component identity -->
      <!-- SNIPCODE-HOOK start: D7 stop remounting the section on every stage.
           `generation` used to be part of the key, so EVERY stage/unstage
           (which bumps it) tore down and rebuilt the whole FileDiffView -
           highlight cache cleared, scroll position lost, brief flash of
           plain text. repoPath+side is a stable identity for "this section",
           so it now updates via props instead of remounting; ImageDiff still
           gets fresh image data via the separate imageGeneration prop below,
           which its own $effect keys off directly. -->
      {#each sections as section (`${store.repoPath}\u0000${section.side}`)}
      <!-- SNIPCODE-HOOK end -->
        <!-- SNIPCODE-HOOK start: ui/diff D10 sticky hunk header offset -->
        <section class="diff-section" style="--section-h: {sectionHeaderHeight}px">
        <!-- SNIPCODE-HOOK end -->
          <!-- A row, not one button: the open-diff action must not toggle collapse
               (and a button can't nest inside a button). -->
          <!-- SNIPCODE-HOOK start: ui/diff D10 sticky hunk header offset -->
          <div class="section-header" bind:clientHeight={sectionHeaderHeight}>
          <!-- SNIPCODE-HOOK end -->
            <button
              class="section-toggle"
              aria-expanded={!collapsed[section.side]}
              onclick={() => { collapsed[section.side] = !collapsed[section.side]; }}
            >
              <span class="codicon {collapsed[section.side] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>
              <!-- SNIPCODE-HOOK start: D6/X2 file header — status letter, +/- stats, icon per side -->
              <span class="side-badge {section.side}">
                <span class="codicon {section.side === 'staged' ? 'codicon-check' : 'codicon-diff-modified'}"></span>
                {section.label}
                <span class="side-status status-{section.status}" title={section.status}>{section.status}</span>
                {#if section.stats.add || section.stats.del}
                  <span class="side-stats">
                    <span class="stat-add">+{section.stats.add}</span>
                    <span class="stat-del">−{section.stats.del}</span>
                  </span>
                {/if}
              </span>
              <!-- SNIPCODE-HOOK end -->
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
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family); flex-shrink: 0;
  }
  /* SNIPCODE-HOOK start: D6/X2 file header — dir/base */
  .mode-bar-file {
    flex: 1; min-width: 0; overflow: hidden; white-space: nowrap;
    font-size: var(--vscode-font-size, 13px);
    display: flex; align-items: baseline; gap: 0;
  }
  .file-dir { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0.55; }
  .file-base { flex-shrink: 0; font-weight: 600; }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: F4 header shows the old path for a rename+modify */
  .file-old-path { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0.55; text-decoration: line-through; }
  .file-rename-arrow { flex-shrink: 0; opacity: 0.55; padding: 0 4px; }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
  .hunk-nav { display: flex; gap: 2px; flex-shrink: 0; }
  .hunk-nav-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border-radius: 3px;
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-descriptionForeground);
  }
  .hunk-nav-btn:hover { background: rgba(128,128,128,0.15); color: var(--vscode-foreground); }
  .hunk-nav-btn .codicon { font-size: 14px; }
  /* SNIPCODE-HOOK end */
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
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  /* SNIPCODE-HOOK start: D6/X2 badge icon + status letter + stats, tinted per side */
  .side-badge .codicon { font-size: 11px; }
  /* Distinct tint per side (on top of the shared icon) so Staged/Unstaged
     don't read as the same badge at a glance. */
  .side-badge.staged { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 25%, var(--vscode-badge-background)); }
  .side-badge.unstaged { background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #63b0f4) 25%, var(--vscode-badge-background)); }
  .side-status {
    font-weight: 700;
    opacity: 0.9;
  }
  .side-stats { display: inline-flex; gap: 4px; opacity: 0.9; }
  .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #48bf91); }
  .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }
  /* SNIPCODE-HOOK end */

  /* Each FileDiffView renders its own sticky filename toolbar. In this unified
     single-file view that is redundant (the panel title already names the file)
     and it would sticky-overlap the Staged/Unstaged section header. Hide it —
     the section header is the only sticky bar we want per section. */
  .diff-section :global(.diff-toolbar) { display: none; }

  /* SNIPCODE-HOOK start: ui/diff D10 sticky hunk header */
  /* Long hunks used to scroll their own header off-screen while the user was
     still dragging a line selection within them. Pin it just below THIS
     section's own sticky header (--section-h, measured via bind:clientHeight
     above — not a guessed constant, since font-size/zoom changes its real
     height) rather than top:0, which would slide it under the section header
     instead of sitting below it. z-index 2 sits between the section header
     (3, above everything) and the sticky line-gutter (1, below the hunk
     header when both are visible at once). */
  .diff-section :global(.diff-hunk-header) {
    position: sticky;
    top: var(--section-h, 0);
    z-index: 2;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
  /* Same outline FileDiffView already uses for :hover (.diff-hunk.reversible,
     .sbs-hunk.hunk-hover) — reused here for "this is the hunk jumpHunk landed
     on", scoped to Diff.svelte's own sections so it can't leak into
     CommitDetails/PrView's copies of FileDiffView. */
  .diff-section :global(.current-hunk) {
    outline: 1px solid var(--vscode-focusBorder, rgba(120, 120, 255, 0.4));
    outline-offset: -1px;
  }
  /* SNIPCODE-HOOK end */
</style>
