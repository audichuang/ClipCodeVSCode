<script lang="ts">
  /* SNIPCODE-HOOK start: compact sidebar commit graph (whole file is Snipcode-only,
     fenced at file level like src/tree/recent-commits-view.ts) */
  import { onMount, tick } from 'svelte';
  import { getVsCodeApi } from '../lib/vscode-api';
  import { i18n, t } from '../lib/i18n/index.svelte';
  import { DEFAULT_GRAPH_COLORS, resolveGraphColor } from '../lib/utils/graph-color';
  import { formatCommitDate, formatRelativeTime } from '../lib/utils/format-date';
  import { statusColor, statusLabel } from '../lib/utils/file-status';
  import { computeNavigationTarget, computeScrollTop } from '../lib/graph-navigation';
  // components/common only — it imports svelte + lib/actions/tooltip and nothing
  // else, so it cannot drag Shiki into the workbench bundle (which has no
  // 'wasm-unsafe-eval' CSP and would fail silently).
  import ContextMenu from '../components/common/ContextMenu.svelte';

  // Mirrors lib/types.ts Ref: a remote branch keeps the remote in its own
  // field, so `origin/develop` arrives as { name: 'develop', remote: 'origin' }
  // (git-parser.ts:110-119). Rendering `name` alone turned two different
  // remotes' branches into two labels both reading "develop".
  interface CommitRef { type: string; name: string; remote?: string; }
  const refName = (ref: CommitRef) =>
    ref.type === 'remote-branch' && ref.remote ? `${ref.remote}/${ref.name}` : ref.name;
  // Mirrors git/types.ts Commit for the fields this view renders. `log()`
  // already ships author/body on every row, so the details panel needs no
  // extra round-trip for the message — only for the file list.
  interface Person { name?: string; email?: string; date?: string; }
  interface Commit {
    hash: string; abbreviatedHash: string; subject: string; refs: CommitRef[];
    // All already on the host's payload (`log()` formats %P, %b, %cn/%ce/%cI) —
    // they were simply never declared here, so the panel could not show them.
    body?: string; author?: Person; committer?: Person; parents?: string[];
  }
  interface CommitFile { path: string; status: string; oldPath?: string; }
  interface Point { x: number; y: number; }
  interface GraphPath { points: Point[]; color: number; colorOverride?: string; }
  interface GraphLink { start: Point; control: Point; end: Point; color: number; colorOverride?: string; }
  interface GraphDot { center: Point; color: number; colorOverride?: string; type: string; isHead: boolean; }
  interface State {
    repoPath: string; repoName: string; repos: Array<{ path: string; name: string }>;
    commits: Commit[]; graph: { paths: GraphPath[]; links: GraphLink[]; dots: GraphDot[] };
    ahead: number; behind: number; tracking: boolean; staged: number; unstaged: number; conflicts: number;
    locale: string; scope?: string; branch?: string; loading?: boolean; error?: string;
  }

  const vscode = getVsCodeApi();
  let recent = $state<State | null>(null);
  let loading = $state(true);
  // Selection is keyed by hash, not by index: the 180ms-debounced refresh
  // replaces `recent` wholesale, and an index would silently point at another
  // commit as soon as a new one lands on HEAD.
  let selectedHash = $state<string | null>(null);
  let files = $state<CommitFile[] | null>(null);
  let filesError = $state<string | null>(null);
  // Plain locals, not $state: only the retry arithmetic reads them.
  let filesRequestedAt = 0;
  // A dropped reply is only recoverable by asking again on the next state, but
  // state arrives on every 180ms-debounced tree change — without this floor a
  // slow merge query would be re-issued faster than it can finish.
  const FILES_RETRY_MS = 1000;
  const selectedCommit = $derived(recent?.commits.find(commit => commit.hash === selectedHash));
  interface MenuEntry { label: string; icon?: string; action: () => void; separator?: boolean; }
  let menu = $state<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();

  // Geometry copied from VS Code's own Source Control Graph so this view reads as
  // a native SCM view rather than a shrunken copy of our full-page graph:
  // row/swimlane height 22, one lane per 11-12px, dot radius 5 (measured in
  // 1.136.1's `workbench.desktop.main.{js,css}` — `getHeight(){return 22}`,
  // the graph constants `22 / 11 / 5`, and `.history-item > .graph-container`).
  const ROW_H = 22;
  const DOT_R = 5;
  const LANE_PAD = 6;
  // The builder emits x in PIXELS already (git-graph-builder's `UNIT_W = 12`),
  // not lane indices, so lanes need no rescaling — the previous
  // `clamp(28..72)` + rescale made the lane column's width depend on how many
  // lanes happened to be visible, which is the one thing a fixed gutter should
  // never do. Only the pathological case is capped.
  const MAX_LANE_W = 96;

  // Native paints exactly ONE ref name per row and collapses the rest into
  // icon+count pills (see `_renderBadges`: the first *coloured* ref renders with
  // its description, every other ref is grouped by colour then icon and renders
  // icon-only; uncoloured refs are dropped entirely unless `scm.graph.badges`
  // is "all"). Importance order below is our equivalent of native's colour
  // assignment — HEAD's own branch first, which is precisely the ref the old
  // `type === 'remote-branch' || type === 'tag'` filter threw away, so a local
  // branch like `develop` could never be labelled at all.
  const NAMED_PRIORITY = ['head', 'branch', 'remote-branch', 'tag'];
  const REF_ICON: Record<string, string> = {
    head: 'codicon-git-branch', branch: 'codicon-git-branch',
    'remote-branch': 'codicon-cloud', tag: 'codicon-tag', stash: 'codicon-archive',
  };
  const REF_COLOR: Record<string, string> = {
    head: 'var(--vscode-scmGraph-historyItemRefColor)',
    // Native reserves historyItemBaseRefColor for the RESOLVED base/merge-base
    // ref; `branch` here means any local branch (git-parser.ts:121), so it takes
    // the ordinary local-ref colour.
    branch: 'var(--vscode-scmGraph-historyItemRefColor)',
    'remote-branch': 'var(--vscode-scmGraph-historyItemRemoteRefColor)',
  };

  // One pass, no spread: `Math.min(...xs)` throws RangeError once the argument
  // count gets large enough, which a pathological octopus history can reach.
  function bounds(graph: State['graph']): { min: number; max: number } {
    let min = 0;
    let max = 0;
    const visit = (x: number) => { if (x < min) min = x; if (x > max) max = x; };
    for (const path of graph.paths) for (const point of path.points) visit(point.x);
    for (const dot of graph.dots) visit(dot.center.x);
    for (const link of graph.links) { visit(link.start.x); visit(link.control.x); visit(link.end.x); }
    return { min, max };
  }
  const minX = (graph: State['graph']) => bounds(graph).min;
  const laneWidth = (graph: State['graph']) => {
    const { min, max } = bounds(graph);
    return Math.min(MAX_LANE_W, Math.max(2 * LANE_PAD + DOT_R, max - min + 2 * LANE_PAD));
  };
  const sy = (y: number) => y * ROW_H;
  const sx = (graph: State['graph'], x: number) => LANE_PAD + (x - minX(graph));
  const points = (items: Point[], graph: State['graph']) =>
    items.map(point => `${sx(graph, point.x)},${sy(point.y)}`).join(' ');
  // Lane colours stay on the SHARED palette, not native's five `scmGraph.foreground*`
  // tokens. G1 made branch colour stable per branch and the lane↔badge colour
  // correspondence is the thing this graph has over IntelliJ's right-hand
  // labels — a 5-colour sidebar next to the full graph's 12-colour palette
  // would give the same branch two different colours across two surfaces, and
  // would also silently drop the user's `branchColorRules` overrides for every
  // branch that isn't explicitly configured. Only the *ref pill* colours below
  // are native's, and those are semantic (ref / remote / base), not per-lane.
  const laneColor = (value: number, override?: string) =>
    resolveGraphColor(DEFAULT_GRAPH_COLORS, value, override);

  interface Badge { icon: string; color?: string; name?: string; count: number; title: string; }

  function badges(commit: Commit): Badge[] {
    const refs = commit.refs.filter(ref => ref.type !== 'stash');
    if (refs.length === 0) return [];
    const namedIndex = NAMED_PRIORITY
      .map(type => refs.findIndex(ref => ref.type === type))
      .find(index => index >= 0);
    const out: Badge[] = [];
    const rest = refs.slice();
    if (namedIndex !== undefined) {
      const [named] = rest.splice(namedIndex, 1);
      out.push({
        icon: REF_ICON[named.type] ?? 'codicon-git-branch',
        color: REF_COLOR[named.type], name: refName(named), count: 1, title: refName(named),
      });
    }
    // Everything left over collapses into ONE counted pill. Native groups the
    // remainder by colour and then by icon, which can still emit several pills —
    // measured at 300px that produced 126+22+22px of labels and left a 70px
    // subject (20px at 250px). Native gets away with it because its default
    // `scm.graph.badges: "filter"` drops uncoloured refs (tags included)
    // outright; capping at two pills instead keeps that information reachable
    // via the tooltip while bounding the label strip to ~148px.
    if (rest.length > 0) {
      out.push({
        icon: REF_ICON[rest[0].type] ?? 'codicon-git-branch',
        color: REF_COLOR[rest[0].type],
        count: rest.length,
        title: rest.map(refName).join('\n'),
      });
    }
    return out;
  }

  function isHead(commit: Commit): boolean { return commit.refs.some(ref => ref.type === 'head'); }
  function request(type: string, payload?: unknown): void { vscode.postMessage({ type, payload }); }

  // Clicking a row selects it and loads its file list into the panel below —
  // it does NOT open the full graph. Only the explicit Open Full Graph title
  // action replaces the editor (graph/AGENTS.md). Clicking the selected row
  // again collapses the panel, giving the list all its height back.
  // Every commit-scoped request names the repo the row came from. The host
  // drops it when that is no longer the active repo — the active repo switches
  // synchronously while this view still shows the old one, and two repos
  // sharing a commit would otherwise open the wrong repository's file.
  function requestFiles(hash: string): void {
    filesRequestedAt = Date.now();
    request('recentCommitsSelectCommit', { hash, repoPath: recent?.repoPath });
  }

  function openCommit(commit: Commit): void {
    if (selectedHash === commit.hash) return;
    selectedHash = commit.hash;
    files = null;
    filesError = null;
    requestFiles(commit.hash);
    // Opening the panel shrinks the list under the row that was just clicked:
    // at 320px the list goes from 13 rows to 4, so clicking row 8 left the
    // selected row 88px below the fold with nothing highlighted on screen.
    // Every entry point (click, ↑/↓, parent link, context menu) selects through
    // here, so the reveal belongs here and not at each call site. `tick()`
    // first — `revealRow` measures `clientHeight`, which is only the post-panel
    // height once Svelte has flushed.
    void tick().then(() => revealRow(commit.hash));
  }

  // Clicking the selected row again collapses the panel; keyboard stepping must
  // NOT toggle, so it goes through openCommit directly.
  function selectCommit(commit: Commit): void {
    if (selectedHash === commit.hash) { closeDetails(); return; }
    openCommit(commit);
  }

  function closeDetails(): void {
    selectedHash = null;
    files = null;
    filesError = null;
  }

  function openFile(file: CommitFile): void {
    if (!selectedHash) return;
    request('recentCommitsOpenFile', {
      hash: selectedHash, path: file.path, oldPath: file.oldPath, repoPath: recent?.repoPath,
    });
  }

  function onRowKey(event: KeyboardEvent, commit: Commit): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectCommit(commit);
  }

  /**
   * ↑/↓ step the selection, Ctrl/Cmd follows the first parent / newest child —
   * the same `graph-navigation` helpers the full graph uses, so the two
   * surfaces move through history identically. Scanning a list of commits is
   * this view's main job; doing it with 30 mouse clicks is not scanning.
   */
  function onListKey(event: KeyboardEvent): void {
    // The open menu owns the keyboard (its own window listener closes it on
    // Escape); stepping the selection underneath it would be a second action.
    if (menu || !recent) return;
    const dir = event.key === 'ArrowDown' ? 'down' : event.key === 'ArrowUp' ? 'up' : null;
    if (!dir) return;
    event.preventDefault();
    const rows = recent.commits.map(commit => ({ hash: commit.hash, parents: commit.parents ?? [] }));
    const target = computeNavigationTarget(rows, selectedHash, dir, event.ctrlKey || event.metaKey);
    const commit = target ? recent.commits.find(c => c.hash === target) : undefined;
    if (!commit) return;
    openCommit(commit);
  }

  function revealRow(hash: string): void {
    if (!listEl || !recent) return;
    const index = recent.commits.findIndex(commit => commit.hash === hash);
    if (index < 0) return;
    // Returns null when the row is already comfortably visible.
    const top = computeScrollTop(index, ROW_H, listEl.scrollTop, listEl.clientHeight, 'edge', 1);
    if (top !== null) listEl.scrollTop = top;
    // Roving tabindex: focus has to travel with the selection or the next key
    // press lands on the old row (or outside the list entirely).
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-hash="${hash}"]`)?.focus());
  }

  function copyText(text: string): void {
    request('recentCommitsCopy', { text, repoPath: recent?.repoPath });
  }

  const fullMessage = (commit: Commit) =>
    commit.body?.trim() ? `${commit.subject}\n\n${commit.body.trim()}` : commit.subject;

  const SEPARATOR: MenuEntry = { label: '', action: () => {}, separator: true };

  /** Native's commit menu is Open Changes + Copy Commit ID/Message; the SHA
   *  variants match the full graph's own menu, and Copy Full Source is the
   *  reason this extension exists — the sidebar was the one surface without it. */
  function commitMenu(event: MouseEvent, commit: Commit): void {
    // Without this the webview shows VS Code's own (inert) context menu.
    event.preventDefault();
    openCommit(commit);
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: t('recent.openChanges'), icon: 'diff-multiple',
          action: () => request('recentCommitsOpenChanges', {
            hash: commit.hash, subject: commit.subject, repoPath: recent?.repoPath,
          }),
        },
        SEPARATOR,
        { label: t('graph.copySHA'), icon: 'copy', action: () => copyText(commit.hash) },
        { label: t('graph.copyShortSHA'), icon: 'copy', action: () => copyText(commit.abbreviatedHash) },
        { label: t('graph.copyCommitInfo'), icon: 'copy', action: () => copyText(`${commit.abbreviatedHash} - ${commit.subject}`) },
        { label: t('recent.copyMessage'), icon: 'copy', action: () => copyText(fullMessage(commit)) },
        SEPARATOR,
        {
          label: t('recent.copyFullSource'), icon: 'copy',
          action: () => request('recentCommitsCopyFullSource', { hash: commit.hash, repoPath: recent?.repoPath }),
        },
      ],
    };
  }

  function fileMenu(event: MouseEvent, file: CommitFile): void {
    event.preventDefault();
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t('recent.openDiff'), icon: 'diff-single', action: () => openFile(file) },
        { label: t('recent.openFile'), icon: 'go-to-file', action: () => openWorkingFile(file) },
        SEPARATOR,
        { label: t('recent.copyPath'), icon: 'copy', action: () => copyText(file.path) },
        {
          label: t('recent.copyFullSource'), icon: 'copy',
          action: () => request('recentCommitsCopyFullSource', {
            hash: selectedHash, path: file.path, repoPath: recent?.repoPath,
          }),
        },
      ],
    };
  }

  const parentLoaded = (hash: string) => Boolean(recent?.commits.some(commit => commit.hash === hash));

  /** A parent already on screen is a local selection — no round-trip. One that
   *  isn't loaded stays disabled rather than silently doing nothing. */
  function goToParent(hash: string): void {
    const commit = recent?.commits.find(c => c.hash === hash);
    if (!commit) return;
    openCommit(commit);
  }

  /** Only worth a line when it differs: on rebased or cherry-picked history the
   *  committer is who to ask, and on ordinary commits it is pure noise. */
  function committerDiffers(commit: Commit): boolean {
    if (!commit.committer?.name) return false;
    return commit.committer.name !== commit.author?.name
      || commit.committer.email !== commit.author?.email;
  }

  /** The working-tree file, not a diff — native's only inline action here. */
  function openWorkingFile(file: CommitFile): void {
    request('recentCommitsOpenWorkingFile', { path: file.path, repoPath: recent?.repoPath });
  }

  // Full message + who/when for the row tooltip. The compact row can only show
  // the subject, so everything the details panel would show is reachable on
  // hover without selecting first.
  function rowTooltip(commit: Commit): string {
    const lines = [commit.subject];
    const body = commit.body?.trim();
    if (body) lines.push('', body);
    const when = commit.author?.date
      ? `${formatRelativeTime(commit.author.date, recent?.locale)} (${formatCommitDate(commit.author.date)})`
      : '';
    const meta = [commit.author?.name, when, commit.abbreviatedHash].filter(Boolean).join(' · ');
    if (meta) lines.push('', meta);
    return lines.join('\n');
  }

  const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const dirName = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  const fileTooltip = (file: CommitFile) =>
    `${statusLabel(file.status) || file.status} — ${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`;

  onMount(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'recentCommitsCommitFiles') {
        const payload = event.data.payload as { hash: string; files: CommitFile[]; error?: string };
        // A late reply for a commit the user has moved off must not repaint the
        // panel; the host guards the same way, this covers the repo-switch race.
        if (payload.hash !== selectedHash) return;
        files = payload.files ?? [];
        filesError = payload.error ?? null;
        return;
      }
      if (event.data?.type !== 'recentCommitsState') return;
      recent = event.data.payload as State;
      loading = false;
      if (recent.locale) i18n.setLocale(recent.locale);
      // The selected commit can vanish (repo switch, branch checkout, amend).
      // Commit contents are immutable, so a still-present selection keeps the
      // file list it already has instead of re-fetching on every refresh.
      if (selectedHash && !recent.commits.some(commit => commit.hash === selectedHash)) { closeDetails(); return; }
      // The host drops a file-list reply issued while the view was hidden, and
      // nothing else would ever ask again — the panel would sit on "Loading…"
      // for as long as the commit stays selected. A state message only arrives
      // while the view IS visible, so re-asking here is the recovery.
      if (selectedHash && files === null && Date.now() - filesRequestedAt >= FILES_RETRY_MS) requestFiles(selectedHash);
    };
    window.addEventListener('message', receive);
    request('recentCommitsReady');
    return () => window.removeEventListener('message', receive);
  });
  /* SNIPCODE-HOOK end */
</script>

<div class="recent-commits">
  {#if recent?.error}
    <div class="message error"><strong>{recent.repoName}</strong><br /><i class="codicon codicon-error"></i>{recent.error}</div>
  {:else if loading}
    <div class="message">{t('recent.loading')}</div>
  {:else if recent && recent.commits.length === 0}
    <div class="message"><strong>{recent.repoName}</strong><br />{t('recent.noCommits')}</div>
  {:else if recent}
    <div class="summary" title={recent.repoPath}>
      {#if recent.tracking}<span>{t('recent.aheadBehind', { ahead: recent.ahead, behind: recent.behind })}</span>{/if}
      <span>{recent.staged || recent.unstaged || recent.conflicts ? t('recent.changes', { staged: recent.staged, unstaged: recent.unstaged, conflicts: recent.conflicts }) : t('file.noChanges')}</span>
    </div>
    <!-- Tree semantics, like native's Source Control Graph: the list owns the
         arrow keys, each row is a selectable item with a roving tabindex. -->
    <div
      class="commit-list"
      role="tree"
      tabindex="-1"
      bind:this={listEl}
      onkeydown={onListKey}
    >
      <div class="graph-layer" aria-hidden="true">
        <svg width={laneWidth(recent.graph)} height={recent.commits.length * ROW_H + ROW_H} viewBox={`0 0 ${laneWidth(recent.graph)} ${recent.commits.length * ROW_H + ROW_H}`}>
          {#each recent.graph.paths as graphPath}<polyline class="rail" points={points(graphPath.points, recent.graph)} style={`--c: ${laneColor(graphPath.color, graphPath.colorOverride)}`} fill="none" stroke-width="2" />{/each}
          {#each recent.graph.links as link}<path class="rail" d={`M ${sx(recent.graph, link.start.x)} ${sy(link.start.y)} Q ${sx(recent.graph, link.control.x)} ${sy(link.control.y)} ${sx(recent.graph, link.end.x)} ${sy(link.end.y)}`} style={`--c: ${laneColor(link.color, link.colorOverride)}`} fill="none" stroke-width="2" />{/each}
          <!-- Two circles per dot, mirroring native: the outer one is stroked with
               the view background so the dot punches a hole in the rails behind
               it, the inner one carries the lane colour. HEAD stays hollow. -->
          {#each recent.graph.dots as dot}
            <circle class="dot-cut" cx={sx(recent.graph, dot.center.x)} cy={sy(dot.center.y)} r={DOT_R} />
            <circle class="dot" class:hollow={dot.isHead} cx={sx(recent.graph, dot.center.x)} cy={sy(dot.center.y)} r={DOT_R - 1.5} style={`--c: ${laneColor(dot.color, dot.colorOverride)}`} stroke-width="2" />
          {/each}
        </svg>
      </div>
      {#each recent.commits as commit, index (commit.hash)}
        <!-- Selecting stays in the sidebar: the row opens the details panel
             below, never an editor tab. Only the Open Full Graph title action
             replaces the editor (graph/AGENTS.md). -->
        <div
          class="commit-row"
          class:head-row={isHead(commit)}
          class:selected={commit.hash === selectedHash}
          data-hash={commit.hash}
          role="treeitem"
          aria-selected={commit.hash === selectedHash}
          tabindex={(selectedHash ? commit.hash === selectedHash : index === 0) ? 0 : -1}
          style:padding-left={`${laneWidth(recent.graph)}px`}
          title={rowTooltip(commit)}
          onclick={() => selectCommit(commit)}
          onkeydown={(event) => onRowKey(event, commit)}
          oncontextmenu={(event) => commitMenu(event, commit)}
        >
          <span class="commit-subject" class:current={isHead(commit)}>{commit.subject}</span>
          <span class="label-container">
            {#each badges(commit) as badge}
              <span class="label" title={badge.title} style={badge.color ? `--label: ${badge.color}` : ''}>
                {#if badge.count > 1}<span class="count">{badge.count}</span>{/if}
                <i class="codicon {badge.icon}"></i>
                {#if badge.name}<span class="description">{badge.name}</span>{/if}
              </span>
            {/each}
          </span>
        </div>
      {/each}
    </div>
    <!-- Sibling of `.commit-list`, never inside it: the graph SVG is absolutely
         positioned at `y = row * 22`, so anything injected between rows would
         throw every dot off its row. -->
    {#if selectedCommit}
      <div class="details">
        <div class="details-head">
          <span class="hash" title={selectedCommit.hash}>{selectedCommit.abbreviatedHash}</span>
          <button
            class="icon-btn"
            title={t('recent.openChanges')}
            aria-label={t('recent.openChanges')}
            onclick={() => request('recentCommitsOpenChanges', {
              hash: selectedHash, subject: selectedCommit.subject, repoPath: recent?.repoPath,
            })}
          ><i class="codicon codicon-diff-multiple"></i></button>
          <button
            class="icon-btn"
            title={t('recent.closeDetails')}
            aria-label={t('recent.closeDetails')}
            onclick={closeDetails}
          ><i class="codicon codicon-close"></i></button>
        </div>
        <div class="details-body">
          <!-- Message block and file list scroll separately: with one scroller
               a long message pushed the files — the reason the panel exists —
               out of view entirely. -->
          <div class="message-block">
          <div class="commit-message">{selectedCommit.body?.trim() ? `${selectedCommit.subject}\n\n${selectedCommit.body.trim()}` : selectedCommit.subject}</div>
          {#if selectedCommit.author?.name || selectedCommit.author?.date}
            <div class="commit-meta" title={selectedCommit.author?.date ? formatCommitDate(selectedCommit.author.date) : (selectedCommit.author?.email ?? '')}>
              {[
                selectedCommit.author?.name,
                selectedCommit.author?.date ? formatRelativeTime(selectedCommit.author.date, recent.locale) : '',
              ].filter(Boolean).join(' · ')}
            </div>
          {/if}
          {#if committerDiffers(selectedCommit)}
            <div class="commit-meta" title={selectedCommit.committer?.email ?? ''}>
              {t('recent.committer')} · {selectedCommit.committer?.name}
            </div>
          {/if}
          {#if (selectedCommit.parents?.length ?? 0) > 0}
            <div class="commit-parents">
              <span class="parents-label">{t('recent.parents')}</span>
              {#each selectedCommit.parents ?? [] as parent (parent)}
                <button
                  class="parent-link"
                  title={parent}
                  disabled={!parentLoaded(parent)}
                  onclick={() => goToParent(parent)}
                >{parent.substring(0, 7)}</button>
              {/each}
            </div>
          {/if}
          </div>
          {#if filesError}
            <div class="files-note error"><i class="codicon codicon-error"></i>{filesError}</div>
          {:else if files === null}
            <div class="files-note">{t('recent.loadingFiles')}</div>
          {:else if files.length === 0}
            <div class="files-note">{t('recent.noFiles')}</div>
          {:else}
            <div class="files">
              {#each files as file (file.path)}
                <!-- A div, not a button: the row carries its own inline action
                     and a button inside a button is invalid markup. -->
                <div
                  class="file-row"
                  role="button"
                  tabindex="0"
                  title={fileTooltip(file)}
                  onclick={() => openFile(file)}
                  onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFile(file); } }}
                  oncontextmenu={(event) => fileMenu(event, file)}
                >
                  <span class="file-status" style={`color: ${statusColor(file.status)}`}>{file.status}</span>
                  <span class="file-name">{baseName(file.path)}</span>
                  <span class="file-dir">{dirName(file.path)}</span>
                  <button
                    class="inline-action"
                    title={t('recent.openFile')}
                    aria-label={t('recent.openFile')}
                    onclick={(event) => { event.stopPropagation(); openWorkingFile(file); }}
                  ><i class="codicon codicon-go-to-file"></i></button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
  {#if menu}
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#workbench-app) { height: 100%; margin: 0; }
  .recent-commits { height: 100%; box-sizing: border-box; color: var(--vscode-foreground); font: var(--vscode-font-size, 13px) var(--vscode-font-family); padding: 4px 0 6px; display: flex; flex-direction: column; min-height: 0; }
  .summary { display: flex; gap: 6px; min-width: 0; align-items: baseline; justify-content: space-between; padding: 0 8px 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .commit-list { position: relative; flex: 1; min-height: 0; overflow: auto; }
  /* The list holds focus only to receive the arrow keys; the SELECTED ROW is
     the visible focus, so the container must not draw a ring of its own. */
  .commit-list:focus { outline: none; }
  .graph-layer { position: absolute; inset: 0 auto auto 0; pointer-events: none; }

  /* Native row semantics: full-width hover/selection band, no per-row border,
     no monospace hash column (that 42px was 16% of a 300px sidebar's usable
     width and the least identifying thing on the row). */
  .commit-row { position: relative; display: flex; align-items: center; gap: 4px; height: 22px; min-width: 0; padding-right: 8px; }
  .commit-row { cursor: pointer; }
  .commit-row.head-row { background: var(--vscode-list-inactiveSelectionBackground); }
  /* Declared after .head-row so hovering the HEAD row still reacts. */
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  /* Last, so a selected row keeps its band while the pointer is elsewhere and
     while it is the HEAD row. */
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .commit-subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit-subject.current { font-weight: var(--vscode-font-weight-semibold, 600); }

  /* `.label-container` / `.label` geometry is native's, values included: pills
     are radius 10 with an 18px line box, the icon is 12px, and only the single
     named ref carries a description — capped at 100px, not the 64px that made a
     branch name unreadable at any real length. */
  .label-container { display: flex; flex-shrink: 0; margin-left: 4px; gap: 4px; }
  .label { display: flex; align-items: center; border-radius: 10px; line-height: 18px; padding: 0 2px; color: var(--vscode-scmGraph-historyItemHoverLabelForeground, var(--vscode-badge-foreground)); background: var(--label, var(--vscode-scmGraph-historyItemHoverDefaultLabelBackground, var(--vscode-badge-background))); }
  .label .count { font-size: 12px; padding: 0 2px 0 4px; }
  .label .codicon { color: inherit; font-size: 12px; padding: 3px; }
  .label .description { font-size: 12px; padding-right: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }

  /* Details panel: a bounded second pane. `flex: 0 0 auto` + max-height, never a
     fixed height — a one-file commit should not reserve the space a forty-file
     one needs. The cap is 65%, not the 45% this shipped with: the sidebar view
     is ~3/7 of the side bar (package.json `initialSize`), so 45% of a 320px view
     left 71px for the file list — three rows — while the commit list kept 151px
     the user had just finished reading. The list still keeps 35% (five rows at
     320px), which is enough to step through with ↑/↓. */
  .details { flex: 0 0 auto; max-height: 65%; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
  .details-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 4px 3px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .details-head .hash { flex: 0 0 auto; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); }
  .icon-btn { flex: 0 0 auto; display: flex; padding: 2px; border: none; border-radius: 4px; background: none; color: var(--vscode-icon-foreground); cursor: pointer; }
  /* Whatever metadata is present, the actions still sit at the right edge. */
  .icon-btn:first-of-type { margin-left: auto; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .icon-btn .codicon { font-size: 14px; }
  .details-body { display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding: 0 8px 6px; }
  /* 40% of the panel, down from 48%: the message, its author line and the parent
     buttons all scroll together here, and the file list — the reason the panel
     opens — gets the rest. A share, not a fixed em cap, so a tall side bar spends
     its extra pixels on both. The full message is also on the row tooltip and in
     the context menu's Copy Message. Its border is also the scroller's own edge:
     without one a clipped message ended in a half-height glyph that read as
     broken text rather than as "scroll for more". */
  .message-block { flex: 0 1 auto; min-height: 0; max-height: 40%; overflow: auto; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); margin-bottom: 4px; }
  .commit-message { line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .commit-meta { margin: 2px 0 6px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
  .files { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: auto; }
  /* `flex: 0 0 22px`, never a bare `height`: `.files` is a column flex container,
     so every row is a flex ITEM, and the `overflow: hidden` below zeroes its
     automatic minimum size. A plain height was therefore only a flex BASIS the
     rows shrank away from — 12 files in a 71px panel rendered 12 rows of 6px
     with the text overlapping, and `.files`'s `overflow: auto` never fired
     because the content had already been squashed to fit.
     `overflow: hidden` itself is defensive, not a fix for an observed overflow:
     the inline action is the one element that appears (on hover) with no layout
     pass to absorb its 20px, and the only thing currently guaranteeing room is
     `.file-name`'s 62% cap. Measured at 300px with a 32-char name and an empty
     directory: rowScrollWidth === rowClientWidth, body/app scrollWidth
     unchanged on reveal. Raise that cap and this line is what still holds. */
  .file-row { display: flex; flex: 0 0 22px; align-items: center; gap: 6px; min-width: 0; overflow: hidden; cursor: pointer; }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .file-status { flex: 0 0 12px; text-align: center; font-weight: var(--vscode-font-weight-semibold, 600); }
  /* The name is what identifies the file, so the directory absorbs the shrink
     first (`flex: 0 0 auto` + a cap on the name). Letting both shrink turned
     `RecentCommits.svelte` into `RecentCommits.…` at 300px while a long
     directory kept its pixels.
     ponytail: 62% is a fixed cap, so a very long name still truncates while the
     dir keeps its 38%; upgrade path is measuring the two text widths. */
  .file-name { flex: 0 0 auto; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  /* Inline action, native's pattern: absent until the row is hovered or holds
     focus. It takes its 20px from the directory — the row's most disposable
     column — rather than reserving them on every row forever. */
  .inline-action { flex: 0 0 auto; display: none; padding: 2px; border: none; border-radius: 4px; background: none; color: var(--vscode-icon-foreground); cursor: pointer; }
  .file-row:hover .inline-action,
  .file-row:focus-within .inline-action { display: flex; }
  .inline-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .inline-action .codicon { font-size: 14px; }

  .commit-parents { display: flex; align-items: center; gap: 4px; margin: 2px 0 6px; font-size: 11px; }
  .parents-label { color: var(--vscode-descriptionForeground); }
  .parent-link { padding: 0 4px; border: none; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; cursor: pointer; }
  .parent-link:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  /* A parent outside the loaded page can't be selected locally; the full hash
     stays in the tooltip so it is still copyable. */
  .parent-link:disabled { opacity: 0.5; cursor: default; }

  .files-note { padding: 4px 0; color: var(--vscode-descriptionForeground); }
  .files-note.error { color: var(--vscode-errorForeground); }
  .files-note .codicon { margin-right: 5px; }

  .message { padding: 10px 8px; color: var(--vscode-descriptionForeground); }
  .message.error { color: var(--vscode-errorForeground); }
  .message .codicon { margin-right: 5px; }
  .graph-layer .rail { stroke: var(--c); stroke-linecap: round; fill: none; }
  .graph-layer .dot-cut { fill: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .graph-layer .dot { fill: var(--c); stroke: var(--c); }
  .graph-layer .dot.hollow { fill: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  /* G11: half the shared palette drops below 3:1 on a light ground, so light and
     HC-light darken the lane colour exactly as the full graph does. */
  :global(body.vscode-light) .graph-layer .rail,
  :global(body.vscode-high-contrast-light) .graph-layer .rail { stroke: color-mix(in oklab, var(--c) 72%, #000); }
  :global(body.vscode-light) .graph-layer .dot,
  :global(body.vscode-high-contrast-light) .graph-layer .dot { fill: color-mix(in oklab, var(--c) 72%, #000); stroke: color-mix(in oklab, var(--c) 72%, #000); }
  :global(body.vscode-light) .graph-layer .dot.hollow,
  :global(body.vscode-high-contrast-light) .graph-layer .dot.hollow { fill: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  :global(body.vscode-high-contrast) .graph-layer .rail,
  :global(body.vscode-high-contrast-light) .graph-layer .rail { stroke-width: 2.5; }
</style>
