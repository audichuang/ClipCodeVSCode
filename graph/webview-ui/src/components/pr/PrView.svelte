<!-- SNIPCODE-HOOK: PR tab (Task G3) — this entire file is new, added for the PR tab.
     Base-ref dropdown -> host `getCommitsBetween` (commits + merge-base + ahead/behind
     + the rename/encoding-correct `-M -z --name-status` file list, all in one round-trip) ->
     Copy Full Source via the existing `snipcodeCopyFullSource` channel. Per-file diffs open
     via `openDiff` (ref1/ref2, with oldPath for renames). Kept as its own component (not
     wired into CommitGraph/CommitDetails) per plan constraints. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { branchStore } from '../../lib/stores/branches.svelte';
  import { uiStore } from '../../lib/stores/ui.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  const vscode = getVsCodeApi();

  interface PrFile {
    path: string;
    status: string;
    oldPath?: string;
  }
  interface PrCommit {
    hash: string;
    subject: string;
    author: string;
    date: string;
  }

  let base = $state<string | null>(null);
  let showBaseDropdown = $state(false);
  /* SNIPCODE-HOOK start: PR tab two-sided compare — head is now selectable
     (was hardcoded 'HEAD' everywhere) so the compare header matches GitHub's
     base...head picker, with a swap button to flip the two. */
  let head = $state<string | null>(null);
  let showHeadDropdown = $state(false);
  /* SNIPCODE-HOOK end */
  let subTab = $state<'files' | 'commits'>('files');

  let commits = $state<PrCommit[]>([]);
  let mergeBase = $state<string | null>(null);
  let ahead = $state(0);
  let behind = $state(0);
  let loadingCommits = $state(false);

  let files = $state<PrFile[]>([]);
  let loadingFiles = $state(false);
  // Repo root captured at the moment `files` are fetched (same reasoning as
  // CommitDetails.svelte's filesRepoRoot: pairs the root with the fetch that
  // produced it rather than reading uiStore.activeRepo at click time).
  let filesRepoRoot = $state('');

  /* SNIPCODE-HOOK start: PR tab (Important 2) — stale-response guard.
     `requestId` (a monotonic counter as a string) is echoed by MainPanel in
     the `commitsBetween` response; a response whose requestId doesn't match
     the in-flight request is from a base/repo the user has since navigated
     away from and must not overwrite the current selection. */
  let requestSeq = 0;
  let currentRequestId: string | null = null;
  /* SNIPCODE-HOOK end */

  // Default base: current branch's upstream, else a remote branch literally
  // named "origin/main", else the first remote branch, else null (dropdown
  // stays unselected — no remotes configured).
  function defaultBase(): string | null {
    const cur = branchStore.currentBranch;
    if (cur?.upstream && !cur.upstreamGone) return cur.upstream;
    const originMain = branchStore.remoteBranches.find((b) => b.name === 'origin/main');
    if (originMain) return originMain.name;
    return branchStore.remoteBranches[0]?.name ?? null;
  }

  function loadCommits(newBase: string, newHead: string) {
    /* SNIPCODE-HOOK start: PR tab (Important 2) — tag this request so a late
       response for a base we've since left can be told apart from the one
       that's still current. */
    const reqId = String(++requestSeq);
    currentRequestId = reqId;
    /* SNIPCODE-HOOK end */
    loadingCommits = true;
    loadingFiles = true;
    commits = [];
    mergeBase = null;
    ahead = 0;
    behind = 0;
    files = [];
    vscode.postMessage({ type: 'getCommitsBetween', payload: { base: newBase, head: newHead, requestId: reqId } });
  }

  function selectBase(b: string) {
    if (base === b) return;
    base = b;
    showBaseDropdown = false;
    /* SNIPCODE-HOOK start: PR tab two-sided compare — only fire once both
       sides are chosen; during default-selection this is a no-op until the
       head default effect below sets `head` too, avoiding a half-configured
       request. */
    if (head !== null) loadCommits(base, head);
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start: PR tab two-sided compare */
  function defaultHead(): string | null {
    return branchStore.currentBranch?.name ?? null;
  }

  function selectHead(h: string) {
    if (head === h) return;
    head = h;
    showHeadDropdown = false;
    if (base !== null) loadCommits(base, head);
  }

  function swap() {
    if (base === null || head === null) return;
    const t = base;
    base = head;
    head = t;
    loadCommits(base, head);
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab (Important 2 / repo-switch race) — after a repo
     switch, `uiStore.activeRepo` updates (host posts `repoList`) BEFORE
     `branchStore.branches` (host posts `branchData`/`fullRefresh` later), so the
     branch list is briefly the OLD repo's. `awaitingBranches` blocks the
     default-base pick until the new repo's branches actually arrive — detected
     by the `branchStore.branches` array reference changing — so we never
     auto-select a base from the stale list. Starts false so a normal first load
     (no switch) auto-selects immediately. */
  // $state so flipping it back to false re-runs the default-base effect below,
  // regardless of effect execution order.
  let awaitingBranches = $state(false);
  let lastBranchesRef = branchStore.branches;
  let lastActiveRepo = uiStore.activeRepo;

  // Reset all PR state on repo switch and wait for the new repo's branches
  // before re-selecting a base (see above). Without the reset a repo switch
  // would leave the previous repo's base/commits/files/banner on screen and
  // let an in-flight response for the old repo land on the new one.
  $effect(() => {
    if (uiStore.activeRepo !== lastActiveRepo) {
      lastActiveRepo = uiStore.activeRepo;
      awaitingBranches = true;
      currentRequestId = null;
      base = null;
      head = null; // SNIPCODE-HOOK: PR tab two-sided compare — never carry a head over from the old repo
      commits = [];
      files = [];
      mergeBase = null;
      ahead = 0;
      behind = 0;
      loadingCommits = false;
      loadingFiles = false;
    }
  });

  // The branches array reference changes when branchData for the (now current)
  // repo arrives (branchStore.setData reassigns the array); that's our signal
  // the switch has completed, so clear the flag and let the default-base effect
  // pick from the new list.
  $effect(() => {
    if (branchStore.branches !== lastBranchesRef) {
      lastBranchesRef = branchStore.branches;
      awaitingBranches = false;
    }
  });

  // Pick a default base once branch data has arrived. Guarded on base===null
  // so this only ever fires once per repo (selectBase always sets a non-null
  // base), and on !awaitingBranches so a repo switch can't select from the
  // previous repo's stale branch list.
  $effect(() => {
    if (!awaitingBranches && base === null && branchStore.branches.length > 0) {
      const d = defaultBase();
      if (d) selectBase(d);
    }
  });

  /* SNIPCODE-HOOK start: PR tab two-sided compare — mirrors the default-base
     effect above for head (default: current branch). Independent of it (each
     only sets its own state and only reads the other's already-committed
     value), so whichever runs first is a no-op on the request (see
     selectBase/selectHead's own-null guard) and the second one, seeing both
     sides now set, is the one that actually fires loadCommits — exactly once,
     regardless of effect run order. */
  $effect(() => {
    if (!awaitingBranches && head === null && branchStore.branches.length > 0) {
      const dh = defaultHead();
      if (dh) selectHead(dh);
    }
  });
  /* SNIPCODE-HOOK end */

  function openFile(file: PrFile) {
    vscode.postMessage({
      type: 'openDiff',
      // SNIPCODE-HOOK: PR tab (Important 3) — carry oldPath so a rename's
      // diff resolves its base (left) side from the old name.
      payload: { file: file.path, oldPath: file.oldPath, ref1: mergeBase ?? base ?? undefined, ref2: head ?? 'HEAD' },
    });
  }

  function copyAll() {
    if (files.length === 0) return;
    const payloadFiles = files.map((f) => ({
      repoRootFsPath: filesRepoRoot,
      relativePath: f.path,
      oldRelativePath: f.oldPath,
      status: f.status,
    }));
    vscode.postMessage({ type: 'snipcodeCopyFullSource', payload: { hash: head ?? 'HEAD', files: payloadFiles } });
  }

  function statusColor(s?: string): string {
    if (document.body.classList.contains('vscode-light')) {
      switch (s) {
        case 'A': return '#2e7d32';
        case 'M': return '#8a6d3b';
        case 'D': return '#b71c1c';
        case 'R': return '#1565c0';
        case 'C': return '#6a1b9a';
        default: return 'var(--text-secondary)';
      }
    }
    switch (s) {
      case 'A': return '#4caf50';
      case 'M': return '#e2c08d';
      case 'D': return '#f44336';
      case 'R': return '#2196f3';
      case 'C': return '#9c27b0';
      default: return 'var(--text-secondary)';
    }
  }

  function statusLabel(s?: string): string {
    switch (s) {
      case 'A': return 'Added';
      case 'M': return 'Modified';
      case 'D': return 'Deleted';
      case 'R': return 'Renamed';
      case 'C': return 'Copied';
      default: return '';
    }
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString();
  }

  onMount(() => {
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg.type === 'commitsBetween') {
        /* SNIPCODE-HOOK start: PR tab (Important 1 & 2)
           Important 2: discard a response for a request we've since moved on
           from (base switch, repo switch, or just a slow git call racing a
           fast re-click) — requestId is the authoritative check; the base
           comparison is defense in depth for older hosts/tests that omit it.
           Important 1: `files` now comes straight from commitsBetween's own
           `-M -z --name-status` diff (rename/encoding-correct), not a
           separate compareCommits()/diffFiles() round-trip — that path had no
           rename detection and split every rename into a delete+add. */
        if (msg.payload.requestId !== currentRequestId || msg.payload.base !== base) return;
        commits = msg.payload.commits;
        mergeBase = msg.payload.mergeBase;
        ahead = msg.payload.ahead;
        behind = msg.payload.behind;
        files = msg.payload.files ?? [];
        filesRepoRoot = uiStore.activeRepo;
        loadingCommits = false;
        loadingFiles = false;
        /* SNIPCODE-HOOK end */
      }
      /* SNIPCODE-HOOK start: Minor 1 — a host error while a getCommitsBetween
         request is in flight (e.g. an invalid ref thrown before MainPanel's
         git-service call even starts) never sends a `commitsBetween` reply,
         which otherwise left the Files tab spinning forever. `source` is set
         by MainPanel's catch-all to the message type that failed. */
      if (msg.type === 'error' && msg.payload?.source === 'getCommitsBetween') {
        loadingCommits = false;
        loadingFiles = false;
      }
      /* SNIPCODE-HOOK end */
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<div class="pr-view">
  <div class="pr-header">
    <div class="base-dropdown-wrapper">
      <button class="base-pill" onclick={() => { showBaseDropdown = !showBaseDropdown; }}>
        <i class="codicon codicon-git-branch"></i>
        <span class="base-name">{base ?? t('pr.selectBase')}</span>
        <i class="codicon codicon-chevron-down base-chevron"></i>
      </button>
      {#if showBaseDropdown}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="repo-dropdown-backdrop" onclick={() => { showBaseDropdown = false; }}></div>
        <div class="repo-dropdown">
          {#each branchStore.branches as b (b.name)}
            <button
              class="repo-dropdown-item"
              class:active={base === b.name}
              onclick={() => selectBase(b.name)}
            >
              <i class="codicon {base === b.name ? 'codicon-check' : 'codicon-git-branch'}"></i>
              <span class="repo-dropdown-item-name">{b.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <!-- SNIPCODE-HOOK start: PR tab two-sided compare — swap button (was a
         static arrow-right icon) + head pill/dropdown copied from the base
         pill/dropdown above, bound to head/selectHead/showHeadDropdown. -->
    <button class="pr-swap-btn" onclick={swap} title="Swap" use:tooltip={'Swap base and head'}>
      <i class="codicon codicon-arrow-swap"></i>
    </button>
    <div class="base-dropdown-wrapper">
      <button class="base-pill" onclick={() => { showHeadDropdown = !showHeadDropdown; }}>
        <i class="codicon codicon-git-branch"></i>
        <span class="base-name">{head ?? branchStore.currentBranch?.name ?? 'HEAD'}</span>
        <i class="codicon codicon-chevron-down base-chevron"></i>
      </button>
      {#if showHeadDropdown}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="repo-dropdown-backdrop" onclick={() => { showHeadDropdown = false; }}></div>
        <div class="repo-dropdown">
          {#each branchStore.branches as b (b.name)}
            <button
              class="repo-dropdown-item"
              class:active={head === b.name}
              onclick={() => selectHead(b.name)}
            >
              <i class="codicon {head === b.name ? 'codicon-check' : 'codicon-git-branch'}"></i>
              <span class="repo-dropdown-item-name">{b.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <!-- SNIPCODE-HOOK end -->
  </div>

  {#if behind > 0}
    <div class="pr-banner pr-banner-warning">
      <i class="codicon codicon-warning"></i>
      {t('pr.behindWarning', { count: behind, base: base ?? '' })}
    </div>
  {/if}
  {#if ahead > 0}
    <div class="pr-banner pr-banner-info">
      <i class="codicon codicon-arrow-up"></i>
      {t('pr.aheadInfo', { count: ahead, base: base ?? '' })}
    </div>
  {/if}

  <div class="pr-subtabs">
    <button class="pr-subtab" class:active={subTab === 'files'} onclick={() => { subTab = 'files'; }}>
      {t('pr.filesTab')}{#if files.length} ({files.length}){/if}
    </button>
    <button class="pr-subtab" class:active={subTab === 'commits'} onclick={() => { subTab = 'commits'; }}>
      {t('pr.commitsTab')}{#if commits.length} ({commits.length}){/if}
    </button>
    {#if subTab === 'files'}
      <button class="pr-copy-btn" disabled={files.length === 0} onclick={copyAll} use:tooltip={'Copy Full Source'}>
        <i class="codicon codicon-copy"></i>
        Copy Full Source
      </button>
    {/if}
  </div>

  <div class="pr-content">
    {#if subTab === 'files'}
      <!-- SNIPCODE-HOOK: Minor 1 — files come from the same commitsBetween
           response as commits, so a commit list still loading means the
           Files tab isn't ready either; without loadingCommits here this
           briefly rendered "No changed files" before commits arrived. -->
      {#if loadingCommits || loadingFiles}
        <div class="pr-empty"><span class="spinner"></span> {t('reflog.loading')}</div>
      {:else if files.length === 0}
        <div class="pr-empty">{t('pr.noFiles')}</div>
      {:else}
        <div class="pr-file-list">
          {#each files as file (file.path)}
            <button class="pr-file-row" onclick={() => openFile(file)}>
              <span class="file-status" style="color: {statusColor(file.status)}" use:tooltip={statusLabel(file.status)}>{file.status}</span>
              <span class="pr-file-path">{file.path}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else if loadingCommits}
      <div class="pr-empty"><span class="spinner"></span> {t('reflog.loading')}</div>
    {:else if commits.length === 0}
      <div class="pr-empty">{t('pr.noCommits')}</div>
    {:else}
      <div class="pr-commit-list">
        {#each commits as c (c.hash)}
          <div class="pr-commit-row">
            <span class="pr-commit-hash" use:tooltip={c.hash}>{c.hash.slice(0, 7)}</span>
            <span class="pr-commit-subject">{c.subject}</span>
            <span class="pr-commit-author">{c.author}</span>
            <span class="pr-commit-date">{formatDate(c.date)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .pr-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .pr-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .base-dropdown-wrapper {
    position: relative;
  }

  .base-pill {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    height: 26px;
    max-width: 220px;
    background: rgba(128, 128, 128, 0.12);
    border: 1px solid rgba(128, 128, 128, 0.15);
    color: var(--text-primary);
    border-radius: 6px;
    font-size: inherit;
    cursor: pointer;
  }

  .base-pill:hover {
    background: rgba(128, 128, 128, 0.2);
  }

  .base-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .base-chevron {
    font-size: 10px;
    opacity: 0.6;
  }

  .repo-dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .repo-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    max-width: calc(100vw - 32px);
    max-height: 320px;
    overflow-y: auto;
    background: var(--vscode-menu-background, var(--bg-secondary));
    border: 1px solid var(--vscode-menu-border, var(--border-color));
    border-radius: 6px;
    padding: 4px;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  }

  .repo-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    font-size: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-menu-foreground, var(--text-primary));
    background: transparent;
    border-radius: 4px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .repo-dropdown-item:hover {
    background: var(--vscode-menu-selectionBackground, rgba(128, 128, 128, 0.2));
  }

  .repo-dropdown-item .codicon {
    font-size: 14px;
    width: 14px;
    flex-shrink: 0;
  }

  .repo-dropdown-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* SNIPCODE-HOOK start: PR tab two-sided compare */
  .pr-swap-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    flex-shrink: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .pr-swap-btn:hover {
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-primary);
  }
  /* SNIPCODE-HOOK end */

  .pr-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    font-size: inherit;
    flex-shrink: 0;
  }

  .pr-banner-warning {
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #ff9800) 12%, transparent);
    color: var(--vscode-editorWarning-foreground, #ff9800);
  }

  .pr-banner-info {
    background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 12%, transparent);
    color: var(--text-primary);
  }

  .pr-subtabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .pr-subtab {
    padding: 4px 12px;
    font-size: inherit;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
  }

  .pr-subtab.active {
    background: var(--button-bg);
    color: var(--button-fg);
  }

  .pr-subtab:hover:not(.active) {
    color: var(--text-primary);
    background: rgba(128, 128, 128, 0.1);
  }

  .pr-copy-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    padding: 4px 10px;
    font-size: inherit;
    border-radius: 4px;
    background: var(--button-bg);
    color: var(--button-fg);
  }

  .pr-copy-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .pr-content {
    flex: 1;
    overflow-y: auto;
  }

  .pr-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .pr-file-list, .pr-commit-list {
    display: flex;
    flex-direction: column;
  }

  .pr-file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 14px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-primary);
    cursor: pointer;
    border-bottom: 1px solid var(--border-color);
  }

  .pr-file-row:hover {
    background: var(--bg-hover);
  }

  .file-status {
    width: 14px;
    flex-shrink: 0;
    font-weight: 700;
    text-align: center;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .pr-file-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pr-commit-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 14px;
    border-bottom: 1px solid var(--border-color);
  }

  .pr-commit-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--text-secondary);
    width: 60px;
    flex-shrink: 0;
  }

  .pr-commit-subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pr-commit-author {
    width: 140px;
    flex-shrink: 0;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pr-commit-date {
    width: 100px;
    flex-shrink: 0;
    color: var(--text-secondary);
    text-align: right;
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-color);
    border-top-color: var(--text-secondary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
