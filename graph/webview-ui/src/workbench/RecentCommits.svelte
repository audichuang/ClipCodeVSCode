<script lang="ts">
  /* SNIPCODE-HOOK start: compact sidebar commit graph (whole file is Snipcode-only,
     fenced at file level like src/tree/recent-commits-view.ts) */
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../lib/vscode-api';
  import { i18n, t } from '../lib/i18n/index.svelte';
  import { DEFAULT_GRAPH_COLORS, resolveGraphColor } from '../lib/utils/graph-color';

  // Mirrors lib/types.ts Ref: a remote branch keeps the remote in its own
  // field, so `origin/develop` arrives as { name: 'develop', remote: 'origin' }
  // (git-parser.ts:110-119). Rendering `name` alone turned two different
  // remotes' branches into two labels both reading "develop".
  interface CommitRef { type: string; name: string; remote?: string; }
  const refName = (ref: CommitRef) =>
    ref.type === 'remote-branch' && ref.remote ? `${ref.remote}/${ref.name}` : ref.name;
  interface Commit { hash: string; abbreviatedHash: string; subject: string; refs: CommitRef[]; }
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

  // Clicking a row opens the full graph rather than selecting that exact commit:
  // the graph webview has no host-driven selection entry point today (App.svelte
  // only ever calls `uiStore.selectCommit(null)`), so hash-precise reveal would
  // need a new message plus boot-handshake replay in MainPanel. Deliberately
  // deferred — the coarse jump is still the "I want the real graph" gesture.
  function isHead(commit: Commit): boolean { return commit.refs.some(ref => ref.type === 'head'); }
  function request(type: string, payload?: unknown): void { vscode.postMessage({ type, payload }); }

  onMount(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type !== 'recentCommitsState') return;
      recent = event.data.payload as State;
      loading = false;
      if (recent.locale) i18n.setLocale(recent.locale);
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
    <div class="commit-list">
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
      {#each recent.commits as commit (commit.hash)}
        <!-- Not activatable: graph/AGENTS.md states this view's ordinary
             interactions stay in the sidebar and only the explicit Open Full
             Graph action opens the editor panel. That action is a view-title
             command; a sidebar row that yanks you to an editor tab on click is
             not how VS Code sidebars behave either. The tooltip still carries
             the full subject and the hash. -->
        <div
          class="commit-row"
          class:head-row={isHead(commit)}
          style:padding-left={`${laneWidth(recent.graph)}px`}
          title={`${commit.subject}\n${commit.abbreviatedHash}`}
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
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#workbench-app) { height: 100%; margin: 0; }
  .recent-commits { height: 100%; box-sizing: border-box; color: var(--vscode-foreground); font: var(--vscode-font-size, 13px) var(--vscode-font-family); padding: 4px 0 6px; display: flex; flex-direction: column; min-height: 0; }
  .summary { display: flex; gap: 6px; min-width: 0; align-items: baseline; justify-content: space-between; padding: 0 8px 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .commit-list { position: relative; flex: 1; min-height: 0; overflow: auto; }
  .graph-layer { position: absolute; inset: 0 auto auto 0; pointer-events: none; }

  /* Native row semantics: full-width hover/selection band, no per-row border,
     no monospace hash column (that 42px was 16% of a 300px sidebar's usable
     width and the least identifying thing on the row). */
  .commit-row { position: relative; display: flex; align-items: center; gap: 4px; height: 22px; min-width: 0; padding-right: 8px; }
  .commit-row.head-row { background: var(--vscode-list-inactiveSelectionBackground); }
  /* Declared after .head-row so hovering the HEAD row still reacts. */
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
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
