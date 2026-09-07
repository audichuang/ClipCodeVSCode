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

  // Side-by-side renders every logical hunk twice (once per pane, scroll-
  // synced) - scope to .sbs-left so inline and SBS both yield one entry per
  // logical hunk.
  function hunkEls(): HTMLElement[] {
    return sectionsEl ? [...sectionsEl.querySelectorAll<HTMLElement>('.diff-hunk, .sbs-left .sbs-hunk')] : [];
  }

  function jumpHunk(dir: 1 | -1): void {
    const hunks = hunkEls();
    // Also the count's self-heal: FileDiffView drops hunks past its 3000-line
    // render budget and reveals them on its own "show full diff" toggle, which
    // is internal state the $effect below cannot see.
    hunkTotal = hunks.length;
    if (hunks.length === 0) return;
    // -1 means "no jump made yet", so the first "next" lands on hunk 0 and
    // "prev" at/above index 0 is a no-op instead of wrapping.
    const next = dir === 1 ? Math.min(currentHunk + 1, hunks.length - 1) : currentHunk - 1;
    if (next < 0) return;
    currentHunkEl?.classList.remove('current-hunk');
    currentHunk = next;
    currentHunkEl = hunks[next];
    currentHunkEl.classList.add('current-hunk');
    currentHunkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  /* SNIPCODE-HOOK start: ui/diff D11b change count. The D11 arrows moved without
     ever saying how many changes there are or which one you are on — IntelliJ's
     diff header ("14 differences") is exactly that missing piece. It counts with
     the SAME DOM query the arrows navigate, so the two can never disagree.
     Only PREVIOUS gets a disabled state: that one depends on `currentHunk`
     alone, while disabling NEXT would depend on the count — and a stale count
     (see jumpHunk) would lock navigation out of the hunks it is missing.
     No right-edge overview ruler to go with it: this viewer renders HUNKS, not
     the whole file, so proportional marks tile ~100% of the strip and it
     degrades into a coloured scrollbar. A useful one needs the file's total line
     count from the host to map changes onto file-line space. */
  let hunkTotal = $state(0);

  $effect(() => {
    // Everything that changes WHICH hunks are rendered. Read them so the effect
    // re-runs after Svelte has patched the DOM and the count matches what the
    // arrows will actually find.
    void store.file; void mode; void store.stagedDiff; void store.unstagedDiff;
    void collapsed.staged; void collapsed.unstaged;
    hunkTotal = hunkEls().length;
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
        <div class="hunk-nav-group">
          <button class="hunk-nav-btn" disabled={currentHunk <= 0} aria-label={t('diff.prevHunk')} title={`${t('diff.prevHunk')} (Alt+↑)`} onclick={() => jumpHunk(-1)}>
            <span class="codicon codicon-arrow-up"></span>
          </button>
          <button class="hunk-nav-btn" aria-label={t('diff.nextHunk')} title={`${t('diff.nextHunk')} (Alt+↓)`} onclick={() => jumpHunk(1)}>
            <span class="codicon codicon-arrow-down"></span>
          </button>
        </div>
        <!-- SNIPCODE-HOOK start: ui/diff D11b change count -->
        {#if hunkTotal > 0}
          <span class="hunk-count" title={t('diff.differences', { count: hunkTotal })}>
            <span class="hunk-count-current">{currentHunk >= 0 ? currentHunk + 1 : '–'}</span>/{hunkTotal}
          </span>
        {/if}
        <!-- SNIPCODE-HOOK end -->
      </div>
      <!-- SNIPCODE-HOOK end -->
      <!-- SNIPCODE-HOOK start: ui/diff IntelliJ-style toolbar divider and mode toggle -->
      <div class="mode-bar-divider" aria-hidden="true"></div>
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => setMode('inline')}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => setMode('side-by-side')}>{t('details.sideBySide')}</button>
      </div>
      <!-- SNIPCODE-HOOK end -->
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
              </span>
              {#if section.stats.add || section.stats.del}
                <span class="side-stats" aria-label={`+${section.stats.add} −${section.stats.del}`}>
                  <span class="stat-add">+{section.stats.add}</span>
                  <span class="stat-del">−{section.stats.del}</span>
                </span>
              {/if}
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
  /* SNIPCODE-HOOK start: ui/diff IntelliJ-style toolbar and controls */
  .mode-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    height: 38px; padding: 0 12px;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08)));
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border, rgba(128,128,128,0.2)));
    font-family: var(--vscode-font-family); flex-shrink: 0;
    box-sizing: border-box;
  }
  /* SNIPCODE-HOOK start: D6/X2 file header — dir/base */
  .mode-bar-file {
    flex: 1; min-width: 0; overflow: hidden; white-space: nowrap;
    font-size: var(--vscode-font-size, 13px);
    display: flex; align-items: baseline; gap: 0;
  }
  .file-dir { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0.65; color: var(--vscode-descriptionForeground); }
  .file-base { flex-shrink: 0; font-weight: 600; color: var(--vscode-foreground); }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: F4 header shows the old path for a rename+modify */
  .file-old-path { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0.55; text-decoration: line-through; }
  .file-rename-arrow { flex-shrink: 0; opacity: 0.55; padding: 0 4px; }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
  .hunk-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .hunk-nav-group {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    border-radius: 4px;
    background: var(--vscode-editor-background, rgba(0, 0, 0, 0.15));
    overflow: hidden;
  }
  .hunk-nav-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 22px; padding: 0; border-radius: 0;
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-foreground, #ccc);
    transition: background-color 0.1s, color 0.1s;
  }
  .hunk-nav-btn:first-child {
    border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  }
  .hunk-nav-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    color: var(--vscode-foreground);
  }
  .hunk-nav-btn:active:not(:disabled) {
    background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.25));
  }
  .hunk-nav-btn:disabled {
    opacity: 0.35; cursor: default;
  }
  .hunk-nav-btn .codicon { font-size: 14px; }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: ui/diff D11b change count */
  .hunk-count {
    align-self: center;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0 8px; height: 22px; min-width: 36px; text-align: center;
    font-size: 11px; font-variant-numeric: tabular-nums;
    border-radius: 11px;
    background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
    box-sizing: border-box;
  }
  .hunk-count-current { font-weight: 700; color: var(--vscode-foreground); }
  /* SNIPCODE-HOOK end */

  .mode-bar-divider {
    width: 1px; height: 16px;
    background: var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    flex-shrink: 0;
  }

  .diff-mode-toggle {
    display: inline-flex; align-items: center; gap: 2px;
    background: var(--vscode-input-background, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    border-radius: 4px; padding: 2px;
    box-sizing: border-box; flex-shrink: 0;
  }
  .diff-mode-toggle button {
    height: 20px; padding: 0 9px; font-size: 11px; font-weight: 500; border-radius: 3px;
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer;
    line-height: 20px; transition: color 0.1s, background-color 0.1s;
  }
  .diff-mode-toggle button:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1));
  }
  .diff-mode-toggle button.active {
    background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.25));
    color: var(--vscode-foreground);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }

  /* The panel owns the scroll; each FileDiffView is `stacked` (flex:none, its own
     content height) so both sections form one long page instead of two half-height
     independently-scrolling boxes. */
  .sections { flex: 1; overflow: auto; display: flex; flex-direction: column; }

  /* SNIPCODE-HOOK start: ui/diff IntelliJ-style section header */
  .diff-section { display: flex; flex-direction: column; }
  .section-header {
    display: flex; align-items: center;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.06));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
    position: sticky; top: 0; z-index: 3;
    min-height: 28px;
  }
  .section-toggle {
    flex: 1; display: flex; align-items: center; gap: 6px;
    padding: 3px 12px; border: none; cursor: pointer; text-align: left;
    background: transparent;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
  }
  .section-toggle:hover {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.06));
  }
  .section-open-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; margin-right: 8px;
    border: none; border-radius: 3px; cursor: pointer; background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: background-color 0.1s, color 0.1s;
  }
  .section-open-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    color: var(--vscode-foreground);
  }
  .side-badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 4px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  }
  /* SNIPCODE-HOOK start: D6/X2 badge icon + status letter + stats, tinted per side */
  .side-badge .codicon { font-size: 11px; }
  /* Distinct tint per side (on top of the shared icon) so Staged/Unstaged
     don't read as the same badge at a glance. */
  .side-badge.staged { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 25%, var(--vscode-badge-background)); }
  .side-badge.unstaged { background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #63b0f4) 25%, var(--vscode-badge-background)); }
  .side-status {
    font-weight: 700;
    opacity: 0.95;
  }
  .side-stats {
    display: inline-flex; gap: 6px; margin-left: 2px; padding: 1px 6px;
    font-size: 11px; font-weight: 700; border-radius: 3px;
    background: var(--vscode-editor-background, transparent);
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  }
  .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #48bf91); }
  .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }
  /* SNIPCODE-HOOK end */
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
