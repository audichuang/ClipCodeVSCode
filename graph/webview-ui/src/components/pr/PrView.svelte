<!-- SNIPCODE-HOOK: PR tab (Task G3) — this entire file is new, added for the PR tab.
     Base-ref dropdown -> host `getCommitsBetween` (commits + merge-base + ahead/behind
     + the rename/encoding-correct `-M -z --name-status` file list, all in one round-trip) ->
     Copy Full Source via the existing `snipcodeCopyFullSource` channel. Per-file diffs open
     via `openDiff` (ref1/ref2, with oldPath for renames). Kept as its own component (not
     wired into CommitGraph/CommitDetails) per plan constraints. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { branchStore } from '../../lib/stores/branches.svelte';
  import { uiStore } from '../../lib/stores/ui.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  /* SNIPCODE-HOOK start: PR tab inline diff (Task D2) — stacked FileDiffView
     per changed file, reusing Task D1's diffMode/hideModeToggle prop. */
  import type { DiffData } from '../../lib/types';
  import FileDiffView from '../commit/FileDiffView.svelte';
  /* SNIPCODE-HOOK end */

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

  /* SNIPCODE-HOOK start: PR tab branch-dropdown type-to-filter — each
     dropdown gets its own filter state so typing in one never affects the
     other. The filtered list is a plain $derived case-insensitive substring
     match; an empty filter matches everything for free since
     "anything".includes('') is always true. Closing a dropdown (select,
     backdrop click, Escape, or a repo switch resetting state) always goes
     through closeBaseDropdown/closeHeadDropdown so the filter is cleared and
     the next open starts fresh. */
  let baseFilter = $state('');
  let headFilter = $state('');
  let filteredBaseBranches = $derived(
    branchStore.branches.filter((b) => !b.detached && b.name.toLowerCase().includes(baseFilter.trim().toLowerCase()))
  );
  let filteredHeadBranches = $derived(
    branchStore.branches.filter((b) => !b.detached && b.name.toLowerCase().includes(headFilter.trim().toLowerCase()))
  );

  function closeBaseDropdown() {
    showBaseDropdown = false;
    baseFilter = '';
  }
  function closeHeadDropdown() {
    showHeadDropdown = false;
    headFilter = '';
  }
  function toggleBaseDropdown() {
    if (awaitingBranches) return;
    if (showBaseDropdown) closeBaseDropdown();
    else showBaseDropdown = true;
  }
  function toggleHeadDropdown() {
    if (awaitingBranches) return;
    if (showHeadDropdown) closeHeadDropdown();
    else showHeadDropdown = true;
  }

  // Svelte action: focus the filter input the instant its dropdown mounts
  // (the {#if} block re-creates it fresh on every open) so the user can
  // start typing immediately without an extra click.
  function focusInput(node: HTMLInputElement) {
    node.focus();
  }
  /* SNIPCODE-HOOK end */

  let subTab = $state<'files' | 'commits'>('files');

  let commits = $state<PrCommit[]>([]);
  let mergeBase = $state<string | null>(null);
  let ahead = $state(0);
  let behind = $state(0);
  let loadingCommits = $state(false);

  let files = $state<PrFile[]>([]);
  let loadingFiles = $state(false);
  /* SNIPCODE-HOOK start: PR tab (P0-2/P2) empty-state machine — the last host
     error for the in-flight/most-recent getCommitsBetween request, shown
     inline in .pr-empty instead of relying solely on the global error bar
     (which auto-dismisses after a few seconds — App.svelte's ui store timer). */
  let lastError = $state<string | null>(null);
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: PR tab inline diff (Task D2) — parsed diffs for the
     current compare (Task D1's commitsBetween.diffs) plus the shared
     inline/side-by-side mode every stacked FileDiffView renders with, and a
     ref to the scrolling diff pane for prev/next-change nav — (P5) this is now
     `.pr-diff-stack` specifically, not the outer `.pr-content`, since the
     Files sub-tab's file list and diff stack scroll independently.
     currentHunk (fix: index-based prev/next nav) is a plain index into the
     flattened hunk list jumpChange walks; -1 means "no jump made yet" so the
     first "next" press lands on the first hunk (index 0) instead of skipping
     it. Reset to -1 wherever the underlying hunk list changes (new
     compare/repo, diffMode flip) — see loadCommits, the repo-switch effect,
     and the diff-mode-toggle buttons. */
  let diffs = $state<DiffData[]>([]);
  let diffMode = $state<'inline' | 'side-by-side'>('inline');
  let prContentEl = $state<HTMLElement | undefined>();
  let currentHunk = $state(-1);
  /* SNIPCODE-HOOK end */
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
  // named "origin/main", else the first remote branch, else (P0-2/P2) a
  // conventional local mainline branch (main/master/develop, in that order),
  // else null (dropdown stays unselected — nothing sensible to default to).
  // The local fallback matters for a repo with no remote configured at all —
  // without it, `base` (and so any getCommitsBetween request) never fires and
  // the Files/Commits tabs are permanently stuck on "pickBase".
  function defaultBase(): string | null {
    const cur = branchStore.currentBranch;
    if (cur?.upstream && !cur.upstreamGone) return cur.upstream;
    const originMain = branchStore.remoteBranches.find((b) => b.name === 'origin/main');
    if (originMain) return originMain.name;
    if (branchStore.remoteBranches[0]) return branchStore.remoteBranches[0].name;
    /* SNIPCODE-HOOK start: PR tab (P2) local-branch fallback */
    for (const name of ['main', 'master', 'develop']) {
      const local = branchStore.localBranches.find((b) => b.name === name && b.name !== cur?.name);
      if (local) return local.name;
    }
    /* SNIPCODE-HOOK end */
    return null;
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
    /* SNIPCODE-HOOK start: PR tab (P1/R7) stale-data refresh — do NOT clear
       commits/mergeBase/ahead/behind/files/diffs here. This function now also
       runs as a background refresh (see the branchStore.branches effect
       below) while the previous compare's data is still on screen; clearing
       it immediately would flash the view to empty/spinner on every commit,
       fetch, or checkout while the PR tab is open. The requestId + base echo
       guard in the commitsBetween handler already makes it safe to keep the
       stale values until the fresh response lands and replaces them
       atomically. (The `error` handler below still clears them, so a failed
       refresh doesn't leave stale data on screen looking current.) */
    currentHunk = -1; // new compare, new hunk list
    lastError = null; // SNIPCODE-HOOK: PR tab (P0-2/P2) empty-state machine — clear any previous error for this new attempt
    /* SNIPCODE-HOOK end */
    vscode.postMessage({ type: 'getCommitsBetween', payload: { base: newBase, head: newHead, requestId: reqId } });
  }

  function selectBase(b: string) {
    /* SNIPCODE-HOOK start: PR tab (Important, repo-switch stale-head race) —
       while awaitingBranches is true the pickers still render the OLD repo's
       branchStore.branches (the new repo's branchData hasn't landed yet), so
       a pick here would set `base` to an OLD-repo ref that then survives into
       the NEW-repo default-base/head selection below, mismatching refs across
       repos. Pills are also disabled for this window (see template); this is
       defense in depth against any path that still calls selectBase/selectHead
       (e.g. a stale dropdown left open across the switch). */
    if (awaitingBranches) return;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: PR tab (Medium) — re-picking the already-selected
       base must still close+clear the dropdown per the pick contract (any
       selection closes the dropdown); only the reload is skipped. Returning
       before closeBaseDropdown() left the dropdown open with a live filter
       when the user picked the currently-active branch (e.g. Enter on an
       already-active first-filtered result, or clicking the active item). */
    if (base === b) {
      closeBaseDropdown();
      return;
    }
    /* SNIPCODE-HOOK end */
    base = b;
    closeBaseDropdown(); // SNIPCODE-HOOK: PR tab branch-dropdown type-to-filter — also clears the filter
    /* SNIPCODE-HOOK start: PR tab two-sided compare — only fire once both
       sides are chosen; during default-selection this is a no-op until the
       head default effect below sets `head` too, avoiding a half-configured
       request. */
    if (head !== null) loadCommits(base, head);
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start: PR tab two-sided compare */
  function defaultHead(): string | null {
    // Detached HEAD: the pseudo-branch name "(HEAD detached at …)" is not a
    // real ref — leave head unselected instead of sending it to git.
    const cur = branchStore.currentBranch;
    return cur && !cur.detached ? cur.name : null;
  }

  function selectHead(h: string) {
    // SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) — same
    // guard as selectBase above; see its comment.
    if (awaitingBranches) return;
    /* SNIPCODE-HOOK start: PR tab (Medium) — same fix as selectBase above:
       re-picking the already-active head must still close+clear the
       dropdown, just skip the reload. See selectBase's comment. */
    if (head === h) {
      closeHeadDropdown();
      return;
    }
    /* SNIPCODE-HOOK end */
    head = h;
    closeHeadDropdown(); // SNIPCODE-HOOK: PR tab branch-dropdown type-to-filter — also clears the filter
    if (base !== null) loadCommits(base, head);
  }

  function swap() {
    // SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) — same
    // guard as selectBase above; see its comment.
    if (awaitingBranches) return;
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
      // SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) — close
      // any dropdown left open across the switch so it can't keep rendering
      // the OLD repo's branch list while awaitingBranches is true. Routed
      // through close*Dropdown (SNIPCODE-HOOK: PR tab branch-dropdown
      // type-to-filter) so a stale filter doesn't survive into the new repo.
      closeBaseDropdown();
      closeHeadDropdown();
      commits = [];
      files = [];
      diffs = []; // SNIPCODE-HOOK: PR tab inline diff (Task D2)
      currentHunk = -1; // SNIPCODE-HOOK: PR tab prev/next-change nav (fix) — repo switch, new hunk list
      mergeBase = null;
      ahead = 0;
      behind = 0;
      loadingCommits = false;
      loadingFiles = false;
      lastError = null; // SNIPCODE-HOOK: PR tab (P0-2/P2) empty-state machine — an old repo's error must not leak into the new repo's empty state
    }
  });

  // The branches array reference changes when branchData for the (now current)
  // repo arrives (branchStore.setData reassigns the array); that's our signal
  // the switch has completed, so clear the flag and let the default-base effect
  // pick from the new list.
  /* SNIPCODE-HOOK start: PR tab (P1/R7) stale-data refresh — a commit, fetch,
     pull, or checkout while the PR tab is open triggers a host fullRefresh,
     which re-posts branchData and so reassigns branchStore.branches even
     when there was no repo switch. That's also our only signal that fresh ref
     data has landed, so once a compare is already configured (base && head
     both selected — this is NOT a repo switch, that path resets both to null
     first, see the effect above) re-request the same compare to pick up any
     new commits/ahead-behind/diff instead of silently going stale. */
  $effect(() => {
    if (branchStore.branches !== lastBranchesRef) {
      lastBranchesRef = branchStore.branches;
      awaitingBranches = false;
      if (base && head) loadCommits(base, head);
    }
  });
  /* SNIPCODE-HOOK end */

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

  /* SNIPCODE-HOOK start: PR tab resizable file-list/diff splitter — mirrors
     CommitDetails.svelte's resize-handle pattern (filesPanelWidth/startResize/
     onResizeMove/stopResize, :190,224-247) for the Files sub-tab's
     file-list/diff split, which previously had a CSS-fixed width
     (.pr-files-layout .pr-file-list). Not persisted across sessions, same as
     CommitDetails' filesPanelWidth. */
  let fileListWidth = $state(240);
  let isResizingFiles = $state(false);
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function startResize(e: MouseEvent) {
    e.preventDefault();
    isResizingFiles = true;
    resizeStartX = e.clientX;
    resizeStartWidth = fileListWidth;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', stopResize);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  function onResizeMove(e: MouseEvent) {
    fileListWidth = Math.min(600, Math.max(120, resizeStartWidth + (e.clientX - resizeStartX)));
  }

  function stopResize() {
    isResizingFiles = false;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', stopResize);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }

  onDestroy(() => {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', stopResize);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
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

  /* SNIPCODE-HOOK start: PR tab inline diff (Task D2) — left file-list click
     now scrolls to that file's stacked FileDiffView section instead of
     opening the native diff editor (the inline diff replaces that need; a
     file with no parsed diff still renders a placeholder whose own "Open
     native diff" button calls openFile). Matched via a data attribute
     rather than a CSS.escape'd attribute selector, since file paths can
     contain characters `querySelector` would otherwise choke on. */
  function scrollToFile(file: PrFile) {
    const target = prContentEl
      ? [...prContentEl.querySelectorAll<HTMLElement>('[data-pr-file]')].find((el) => el.dataset.prFile === file.path)
      : undefined;
    target?.scrollIntoView({ block: 'start' });
  }

  // Prev/next-change nav (fix: index-based, not viewport-center-based).
  // The old version used the `.pr-content` container's live center line as
  // the cursor: on first load the first hunk sits ABOVE that line, so the
  // first "next" press skipped it entirely (a single-hunk PR's "next" was a
  // permanent no-op), and "prev" at the top could still jump to that same
  // first hunk even though there's nothing before it. currentHunk is a plain
  // index into the flattened hunk list instead: -1 means "no jump made yet",
  // so the first "next" lands on index 0 (the very first hunk), and "prev"
  // at/above index 0 is a no-op rather than wrapping or re-centering hunk 0.
  // Side-by-side renders every logical hunk twice — once in `.sbs-left`, once
  // in the scroll-synced `.sbs-right` pane — so hunks scopes to `.sbs-left
  // .sbs-hunk` rather than `.sbs-hunk` to keep one entry per logical hunk in
  // both modes (no rect-based de-dup needed).
  function jumpChange(dir: 1 | -1) {
    const container = prContentEl;
    if (!container) return;
    const hunks = [...container.querySelectorAll<HTMLElement>('.diff-hunk, .sbs-left .sbs-hunk')];
    if (hunks.length === 0) return;
    if (dir === 1) {
      currentHunk = Math.min(currentHunk + 1, hunks.length - 1);
    } else {
      if (currentHunk <= 0) return;
      currentHunk = currentHunk - 1;
    }
    hunks[currentHunk]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  /* SNIPCODE-HOOK end */

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
      case 'A': return t('status.added');
      case 'M': return t('status.modified');
      case 'D': return t('status.deleted');
      case 'R': return t('status.renamed');
      case 'C': return t('status.copied');
      default: return '';
    }
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString();
  }

  /* SNIPCODE-HOOK start: PR tab (P0-2/P2) empty-state machine — "No changed
     files" / "No commits" used to be the single shared message for four very
     different situations (nothing selected yet, detached HEAD, a host error,
     and a genuine no-diff compare), which reads as "there is nothing here"
     even when the real reason is "you haven't picked a base yet" or
     "something failed". Plain functions (not $derived) so they react like the
     existing statusColor/statusLabel above — called from the template, which
     re-evaluates whenever the $state they read changes.
     Precedence: an in-flight error always wins (freshest signal); then a
     detached HEAD (a real, distinct situation — not just "no ref picked");
     then no base/head picked yet; then same ref; then a real compare with
     nothing new on head (ahead === 0); 'noDiff' is the leftover Files-tab-only
     case where there ARE commits ahead but the diff nets to nothing (e.g. an
     empty commit) — Commits tab can't hit it, ahead>0 implies commits.length>0. */
  type EmptyReason = 'pickBase' | 'detached' | 'error' | 'sameRef' | 'upToDate' | 'noDiff';

  function emptyReason(kind: 'files' | 'commits'): EmptyReason | null {
    if (lastError !== null) return 'error';
    if (branchStore.currentBranch?.detached) return 'detached';
    if (base === null || head === null) return 'pickBase';
    if (base === head) return 'sameRef';
    if (ahead === 0) return 'upToDate';
    if (kind === 'files' && files.length === 0) return 'noDiff';
    return null;
  }

  function emptyReasonText(kind: 'files' | 'commits'): string {
    switch (emptyReason(kind)) {
      case 'error': return t('pr.emptyError', { message: lastError ?? '' });
      case 'detached': return t('pr.emptyDetached');
      case 'pickBase': return t('pr.emptyPickBase');
      case 'sameRef': return t('pr.emptySameRef', { base: base ?? '', head: head ?? '' });
      case 'upToDate': return t('pr.emptyUpToDate', { head: head ?? '', base: base ?? '' });
      case 'noDiff': return t('pr.noFiles');
      default: return kind === 'files' ? t('pr.noFiles') : t('pr.noCommits');
    }
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab (P4/X2) +/- stats — computed straight from the
     already-in-memory parsed diffs (diffs[].hunks[].lines), so no host/wire
     change is needed for a "close enough to git" total. Only exact parity
     with `git diff --numstat` would require a host round-trip; not needed
     here. A file with no countable diff (binary, or missing from `diffs` —
     the same placeholder-eligible set the Files sub-tab already falls back
     for) returns null so callers can show "bin" instead of a false "+0 -0". */
  function diffStats(d: DiffData | undefined): { add: number; del: number } | null {
    if (!d || d.isBinary || d.hunks.length === 0) return null;
    let add = 0;
    let del = 0;
    for (const h of d.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add') add++;
        else if (l.type === 'delete') del++;
      }
    }
    return { add, del };
  }

  function fileStats(file: PrFile): { add: number; del: number } | null {
    return diffStats(diffs.find((x) => x.file === file.path));
  }

  let totalStats = $derived.by(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      const s = fileStats(f);
      if (s) { add += s.add; del += s.del; }
    }
    return { add, del };
  });

  function copyMergeBase() {
    if (!mergeBase) return;
    vscode.postMessage({ type: 'copyToClipboard', payload: { text: mergeBase } });
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab (P6) dir/base path split — mirrors
     FileDiffView.svelte's .diff-dir/.diff-base split (dimmed directory
     prefix, bold filename) instead of a single flat path with a trailing
     ellipsis that hides the filename first at narrow widths. */
  function fileDir(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.substring(0, idx + 1);
  }

  function fileBaseName(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.substring(idx + 1);
  }
  /* SNIPCODE-HOOK end */

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
        diffs = msg.payload.diffs ?? []; // SNIPCODE-HOOK: PR tab inline diff (Task D2)
        filesRepoRoot = uiStore.activeRepo;
        loadingCommits = false;
        loadingFiles = false;
        lastError = null; // SNIPCODE-HOOK: PR tab (P0-2/P2) empty-state machine — a success clears any earlier error
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
        lastError = msg.payload?.message ?? ''; // SNIPCODE-HOOK: PR tab (P0-2/P2) empty-state machine
        /* SNIPCODE-HOOK start: PR tab (P1/R7) stale-data refresh — since
           loadCommits no longer clears commits/files/diffs/mergeBase/ahead/
           behind up front (see above), a failed refresh must clear them here
           instead — otherwise a background refresh that errors (e.g. an
           invalid ref after a branch was deleted) would silently leave the
           PREVIOUS compare's data on screen looking current, with no
           indication anything went wrong. */
        commits = [];
        files = [];
        diffs = [];
        mergeBase = null;
        ahead = 0;
        behind = 0;
        /* SNIPCODE-HOOK end */
      }
      /* SNIPCODE-HOOK end */
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<div class="pr-view">
  <div class="pr-header">
    <!-- SNIPCODE-HOOK start: PR tab compare header — GitHub-style "head into base"
         inline layout (head pill · "into" · base pill · swap button on the far
         right). head merges INTO base (base...head three-dot compare). -->
    <div class="base-dropdown-wrapper">
      <!-- SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) —
           same guard as the base pill below; see its comment. -->
      <button class="base-pill" disabled={awaitingBranches} onclick={toggleHeadDropdown}>
        <i class="codicon codicon-git-branch"></i>
        <span class="base-name">{head ?? branchStore.currentBranch?.name ?? 'HEAD'}</span>
        <i class="codicon codicon-chevron-down base-chevron"></i>
      </button>
      {#if showHeadDropdown}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="repo-dropdown-backdrop" onclick={closeHeadDropdown}></div>
        <div class="repo-dropdown">
          <input
            type="text"
            class="dropdown-filter-input"
            placeholder="Filter branches…"
            bind:value={headFilter}
            use:focusInput
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const first = filteredHeadBranches[0];
                if (first) selectHead(first.name);
              } else if (e.key === 'Escape') {
                closeHeadDropdown();
              }
            }}
          />
          {#each filteredHeadBranches as b (b.name)}
            <button
              class="repo-dropdown-item"
              class:active={head === b.name}
              onclick={() => selectHead(b.name)}
            >
              <i class="codicon {head === b.name ? 'codicon-check' : 'codicon-git-branch'}"></i>
              <span class="repo-dropdown-item-name">{b.name}</span>
            </button>
          {:else}
            <div class="repo-dropdown-empty">No matching branches</div>
          {/each}
        </div>
      {/if}
    </div>
    <span class="pr-into">{t('pr.into')}</span>
    <div class="base-dropdown-wrapper">
      <!-- SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) —
           disabled + guarded onclick while awaitingBranches: the dropdown
           below still lists the OLD repo's branchStore.branches until the new
           repo's branchData arrives, so opening it here could let the user
           pick a stale ref. -->
      <button class="base-pill" disabled={awaitingBranches} onclick={toggleBaseDropdown}>
        <i class="codicon codicon-git-branch"></i>
        <span class="base-name">{base ?? t('pr.selectBase')}</span>
        <i class="codicon codicon-chevron-down base-chevron"></i>
      </button>
      {#if showBaseDropdown}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="repo-dropdown-backdrop" onclick={closeBaseDropdown}></div>
        <div class="repo-dropdown">
          <input
            type="text"
            class="dropdown-filter-input"
            placeholder="Filter branches…"
            bind:value={baseFilter}
            use:focusInput
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const first = filteredBaseBranches[0];
                if (first) selectBase(first.name);
              } else if (e.key === 'Escape') {
                closeBaseDropdown();
              }
            }}
          />
          {#each filteredBaseBranches as b (b.name)}
            <button
              class="repo-dropdown-item"
              class:active={base === b.name}
              onclick={() => selectBase(b.name)}
            >
              <i class="codicon {base === b.name ? 'codicon-check' : 'codicon-git-branch'}"></i>
              <span class="repo-dropdown-item-name">{b.name}</span>
            </button>
          {:else}
            <div class="repo-dropdown-empty">No matching branches</div>
          {/each}
        </div>
      {/if}
    </div>
    <button class="pr-swap-btn" aria-label="Swap base and head" onclick={swap} use:tooltip={'Swap base and head'}>
      <i class="codicon codicon-arrow-swap"></i>
    </button>
    <!-- SNIPCODE-HOOK end -->
  </div>

  <!-- SNIPCODE-HOOK start: PR tab (P4/X2) merged stats row — replaces the two
       separate ahead/behind banners (each its own full-width row, and the
       ahead count duplicated the Commits sub-tab's own counter) with one
       compact line: ahead/behind/merge-base/file-count/total +/-. Gated on
       mergeBase !== null (only cleared on a fresh request or a host error —
       see loadCommits/the error handler) so it disappears exactly when there
       is no real compare loaded, and (P1/R7) stays up during a background
       refresh instead of flickering. -->
  {#if mergeBase !== null}
    <div class="pr-stats-row">
      {#if ahead > 0}<span class="pr-stat pr-stat-ahead"><i class="codicon codicon-arrow-up"></i>{t('pr.statsAhead', { count: ahead })}</span>{/if}
      {#if behind > 0}<span class="pr-stat pr-stat-behind"><i class="codicon codicon-arrow-down"></i>{t('pr.statsBehind', { count: behind })}</span>{/if}
      <button class="pr-stat pr-merge-base" onclick={copyMergeBase} use:tooltip={t('pr.copyMergeBase')}>
        <i class="codicon codicon-git-commit"></i>{mergeBase.slice(0, 7)}
      </button>
      <span class="pr-stat">{t('pr.statsFiles', { count: files.length })}</span>
      {#if totalStats.add > 0 || totalStats.del > 0}
        <span class="pr-stat pr-stat-add">+{totalStats.add}</span><span class="pr-stat pr-stat-del">−{totalStats.del}</span>
      {/if}
    </div>
  {/if}
  <!-- SNIPCODE-HOOK end -->

  <div class="pr-subtabs">
    <button class="pr-subtab" class:active={subTab === 'files'} onclick={() => { subTab = 'files'; }}>
      {t('pr.filesTab')}{#if files.length} ({files.length}){/if}
    </button>
    <button class="pr-subtab" class:active={subTab === 'commits'} onclick={() => { subTab = 'commits'; }}>
      {t('pr.commitsTab')}{#if commits.length} ({commits.length}){/if}
    </button>
    {#if subTab === 'files'}
      <!-- SNIPCODE-HOOK start: PR tab inline diff (Task D2) — shared
           inline/side-by-side toggle driving every stacked FileDiffView
           (markup mirrors FileDiffView's own .diff-mode-toggle), plus
           prev/next-change nav within the shared .pr-content pane. -->
      <div class="pr-diff-mode-toggle">
        <!-- SNIPCODE-HOOK: PR tab prev/next-change nav (fix) — a mode flip
             changes the DOM hunk list (inline .diff-hunk vs side-by-side
             .sbs-hunk), so currentHunk must reset or it'd index into the
             wrong set. -->
        <button class:active={diffMode === 'inline'} onclick={() => { diffMode = 'inline'; currentHunk = -1; }}>{t('details.inline')}</button>
        <button class:active={diffMode === 'side-by-side'} onclick={() => { diffMode = 'side-by-side'; currentHunk = -1; }}>{t('details.sideBySide')}</button>
      </div>
      <button class="pr-jump-btn pr-jump-prev" aria-label="Previous change" onclick={() => jumpChange(-1)} use:tooltip={'Previous change'}>
        <i class="codicon codicon-arrow-up"></i>
      </button>
      <button class="pr-jump-btn pr-jump-next" aria-label="Next change" onclick={() => jumpChange(1)} use:tooltip={'Next change'}>
        <i class="codicon codicon-arrow-down"></i>
      </button>
      <!-- SNIPCODE-HOOK end -->
      <button class="pr-copy-btn" disabled={files.length === 0} onclick={copyAll} use:tooltip={'Copy Full Source'}>
        <i class="codicon codicon-copy"></i>
        Copy Full Source
      </button>
    {/if}
  </div>

  <!-- SNIPCODE-HOOK: PR tab (P5) — pr-content-files switches this pane from a
       single scrolling container (Commits tab / empty states) to a plain flex
       row host for two independently-scrolling columns (see .pr-files-layout
       below); bind:this moved to .pr-diff-stack, the pane jumpChange/
       scrollToFile actually need. -->
  <div class="pr-content" class:pr-content-files={subTab === 'files'}>
    {#if subTab === 'files'}
      <!-- SNIPCODE-HOOK: Minor 1 — files come from the same commitsBetween
           response as commits, so a commit list still loading means the
           Files tab isn't ready either; without loadingCommits here this
           briefly rendered "No changed files" before commits arrived. -->
      <!-- SNIPCODE-HOOK start: PR tab (P1/R7) stale-data refresh — only show
           the spinner when there's nothing on screen yet (first ever load).
           A background refresh (loadingFiles true with files already
           populated from the previous compare) keeps showing that stale
           content instead of blanking to a spinner; it's replaced in place
           once the fresh response lands. -->
      {#if (loadingCommits || loadingFiles) && files.length === 0}
        <div class="pr-empty"><span class="spinner"></span> {t('reflog.loading')}</div>
      {:else if files.length === 0}
        <div class="pr-empty">{emptyReasonText('files')}</div>
      {:else}
      <!-- SNIPCODE-HOOK end -->
        <!-- SNIPCODE-HOOK start: PR tab inline diff (Task D2) — left file
             list (click scrolls to the matching section at right) + right
             stacked FileDiffView per changed file, reusing Task D1's
             diffMode/hideModeToggle prop so this one toolbar toggle drives
             every file. Not lazy-loaded: every file's diff renders up front
             (see plan — large PRs are a follow-up, not this version). -->
        <div class="pr-files-layout">
          <div class="pr-file-list" style="width: {fileListWidth}px; flex-shrink: 0;">
            {#each files as file (file.path)}
              {@const s = fileStats(file)}
              <button class="pr-file-row" onclick={() => scrollToFile(file)}>
                <span class="file-status" style="color: {statusColor(file.status)}" use:tooltip={statusLabel(file.status)}>{file.status}</span>
                <!-- SNIPCODE-HOOK start: PR tab (P6) dir/base path split + rename
                     old -> new. No whitespace between the dir/base spans (all on
                     one line, nothing between tags) so "src/" + "b.ts" reads as
                     "src/b.ts" in textContent, not "src/ b.ts". -->
                <span class="pr-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{#if file.oldPath}<span class="pr-rename-old">{file.oldPath}</span>{' → '}{/if}{#if fileDir(file.path)}<span class="pr-dir">{fileDir(file.path)}</span>{/if}<span class="pr-base">{fileBaseName(file.path)}</span></span>
                <!-- SNIPCODE-HOOK end -->
                <!-- SNIPCODE-HOOK: PR tab (P4/X2) per-file +/- stats -->
                <span class="pr-file-stats">
                  {#if s}<span class="pr-stat-add">+{s.add}</span><span class="pr-stat-del">−{s.del}</span>{:else}<span class="pr-stat-bin">{t('pr.statsBinary')}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
          <!-- SNIPCODE-HOOK: PR tab resizable file-list/diff splitter -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="pr-resize-handle"
            class:resizing={isResizingFiles}
            onmousedown={startResize}
            role="separator"
            aria-orientation="vertical"
          ></div>
          <!-- SNIPCODE-HOOK end -->
          <div class="pr-diff-stack" bind:this={prContentEl}>
            {#each files as file (file.path)}
              {@const d = diffs.find((x) => x.file === file.path)}
              <div class="pr-diff-file" data-pr-file={file.path}>
                <!-- SNIPCODE-HOOK: PR tab inline diff (Task D2 fix, blocking review
                     finding) — binary diffs (incl. images) fall through to the
                     placeholder instead of FileDiffView. FileDiffView's
                     isBinary&&isImage branch renders <ImageDiff> with no
                     commitHash prop here (PrView has no single commit — it's a
                     base..head range), which defaults ImageDiff to comparing the
                     index against the working tree, not the PR's mergeBase->head.
                     The placeholder's "Open native diff" button (openFile) posts
                     the correct ref1=mergeBase/ref2=head via openDiff instead. -->
                <!-- SNIPCODE-HOOK start: PR tab (Minor) — pure renames,
                     mode-only changes, and empty add/delete parse to a
                     DiffData entry that is NOT binary but has hunks: [], so
                     the old `d && !d.isBinary` guard rendered an empty
                     FileDiffView with nothing to show and no escape hatch.
                     Requiring d.hunks.length > 0 routes these to the same
                     placeholder + "Open native diff" fallback already used
                     for binary/image files. -->
                {#if d && !d.isBinary && d.hunks.length > 0}
                  <FileDiffView diff={d} stacked diffMode={diffMode} hideModeToggle heading={file.path} />
                {:else}
                  <div class="pr-diff-placeholder">
                    <span class="file-status" style="color: {statusColor(file.status)}" use:tooltip={statusLabel(file.status)}>{file.status}</span>
                    <span class="pr-file-path">{file.path}</span>
                    <button class="pr-open-native-btn" onclick={() => openFile(file)}>
                      <i class="codicon codicon-diff"></i> Open native diff
                    </button>
                  </div>
                {/if}
                <!-- SNIPCODE-HOOK end -->
              </div>
            {/each}
          </div>
        </div>
        <!-- SNIPCODE-HOOK end -->
      {/if}
    {:else if loadingCommits && commits.length === 0}
      <div class="pr-empty"><span class="spinner"></span> {t('reflog.loading')}</div>
    {:else if commits.length === 0}
      <div class="pr-empty">{emptyReasonText('commits')}</div>
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

  /* SNIPCODE-HOOK start: PR tab branch-dropdown type-to-filter */
  .dropdown-filter-input {
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 4px;
    padding: 5px 8px;
    background: var(--input-bg);
    border: 1px solid var(--input-border, var(--border-color));
    border-radius: 4px;
    color: var(--input-fg);
    font-size: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    outline: none;
  }

  .dropdown-filter-input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .repo-dropdown-empty {
    padding: 8px 10px;
    color: var(--text-secondary);
    text-align: center;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab two-sided compare */
  /* SNIPCODE-HOOK: PR tab compare header — connector word + swap pushed right */
  .pr-into {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .pr-swap-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    margin-left: 4px;
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

  /* SNIPCODE-HOOK start: PR tab (P4/X2) merged stats row */
  .pr-stats-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 8px 14px;
    font-size: inherit;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-secondary);
  }

  .pr-stat {
    display: flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: none;
    color: inherit;
    font-size: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    padding: 0;
  }

  .pr-stat-ahead { color: var(--vscode-button-background, #0e639c); }
  .pr-stat-behind { color: var(--vscode-editorWarning-foreground, #ff9800); }

  .pr-merge-base {
    cursor: pointer;
    border-radius: 4px;
    padding: 1px 4px;
  }

  .pr-merge-base:hover {
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-primary);
  }

  .pr-stat-add { color: #4caf50; }
  .pr-stat-del { color: #f44336; }
  .pr-stat-bin { opacity: 0.6; }
  /* SNIPCODE-HOOK end */

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

  /* SNIPCODE-HOOK start: PR tab inline diff (Task D2) — shared diff-mode
     toggle + prev/next-change buttons in the Files toolbar. margin-left:auto
     lives here now (moved off .pr-copy-btn below) since this is the first of
     the group and pushes the whole {toggle, prev, next, copy} cluster right. */
  .pr-diff-mode-toggle {
    display: flex;
    gap: 2px;
    margin-left: auto;
    background: rgba(128, 128, 128, 0.15);
    border-radius: 3px;
    padding: 1px;
  }

  .pr-diff-mode-toggle button {
    padding: 2px 8px;
    font-size: 0.85em;
    border-radius: 2px;
    background: transparent;
    color: var(--text-secondary);
  }

  .pr-diff-mode-toggle button.active {
    background: var(--button-bg);
    color: var(--button-fg);
  }

  .pr-jump-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
  }

  .pr-jump-btn:hover {
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-primary);
  }
  /* SNIPCODE-HOOK end */

  .pr-copy-btn {
    display: flex;
    align-items: center;
    gap: 5px;
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
    min-height: 0;
  }

  /* SNIPCODE-HOOK start: PR tab (P5) — the Files sub-tab used to be one
     scrolling container holding a `position: sticky` file list; sticky has no
     max-height/own scrollbar, so once the file list was taller than the
     viewport its lower rows were only reachable by scrolling the right-hand
     diff stack all the way down first (100+ file PRs). Now the two columns
     scroll independently: `.pr-content-files` turns this pane into a plain
     (non-scrolling) flex row host, and each column gets its own
     `overflow-y: auto`. min-height: 0 on every flex link in this chain is
     required or a flex child's default `min-height: auto` refuses to shrink
     below its content height and neither column's overflow ever kicks in. */
  .pr-content.pr-content-files {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .pr-files-layout {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-height: 0;
  }

  .pr-files-layout .pr-file-list {
    /* SNIPCODE-HOOK: PR tab resizable file-list/diff splitter — width is now
       driven by the inline style (fileListWidth, clamped 120-600px); no
       fixed flex-basis here so that inline width takes effect. */
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--border-color);
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab resizable file-list/diff splitter — mirrors
     CommitDetails.svelte's .resize-handle (:1826-1836). */
  .pr-resize-handle {
    /* SNIPCODE-HOOK: PR tab resize handle — .pr-files-layout is now
       align-items: stretch (P5), so this is redundant for cross-size but kept
       explicit for clarity/robustness against a future layout change.
       border-right dropped — .pr-file-list already draws one divider line;
       keeping both drew two ~5px apart. The hover/active background below is
       still the drag affordance. */
    width: 5px;
    align-self: stretch;
    flex-shrink: 0;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
  }

  .pr-resize-handle:hover,
  .pr-resize-handle.resizing {
    background: var(--vscode-sash-hoverBorder, rgba(128, 128, 128, 0.4));
  }
  /* SNIPCODE-HOOK end */

  .pr-diff-stack {
    flex: 1;
    min-width: 0;
    overflow-y: auto; /* SNIPCODE-HOOK: PR tab (P5) — own scroll, independent of the file list */
  }

  .pr-diff-placeholder {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border-color);
  }

  .pr-open-native-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    padding: 3px 10px;
    font-size: 0.85em;
    border-radius: 4px;
    background: var(--button-bg);
    color: var(--button-fg);
  }
  /* SNIPCODE-HOOK end */

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

  /* SNIPCODE-HOOK start: PR tab (P6) dir/base path split — copies
     FileDiffView.svelte's three .diff-file-name/.diff-dir/.diff-base rules:
     the directory prefix truncates first (dimmed, shrinks), the filename
     itself never truncates (bold, fixed). A flat path + trailing ellipsis
     hid the filename first at a narrow column width — the opposite of what a
     reviewer needs to identify a changed file. */
  .pr-file-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    display: flex;
    align-items: baseline;
    gap: 0;
  }

  .pr-dir {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.55;
    font-weight: normal;
  }

  .pr-base {
    flex-shrink: 0;
    font-weight: 600;
  }

  .pr-rename-old {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.55;
    text-decoration: line-through;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: PR tab (P4/X2) per-file +/- stats */
  .pr-file-stats {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
    font-size: 0.85em;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  /* SNIPCODE-HOOK end */

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
