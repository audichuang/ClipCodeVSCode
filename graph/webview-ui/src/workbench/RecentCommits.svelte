<script lang="ts">
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../lib/vscode-api';
  import { i18n, t } from '../lib/i18n/index.svelte';
  import { DEFAULT_GRAPH_COLORS, resolveGraphColor } from '../lib/utils/graph-color';

  interface CommitRef { type: string; name: string; }
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
  const color = (value: number, override?: string) => resolveGraphColor(DEFAULT_GRAPH_COLORS, value, override);
  const sy = (y: number) => y * 24;
  const xBounds = (graph: State['graph']) => {
    const xs = [
      ...graph.paths.flatMap(path => path.points),
      ...graph.dots.map(dot => dot.center),
      ...graph.links.flatMap(link => [link.start, link.control, link.end]),
    ].map(point => point.x);
    return { min: Math.min(...xs, 0), max: Math.max(...xs, 0) };
  };
  const graphWidth = (graph: State['graph']) => {
    const bounds = xBounds(graph);
    return Math.min(72, Math.max(28, (bounds.max - bounds.min) * 1.5 + 12));
  };
  const sx = (graph: State['graph'], x: number) => {
    const bounds = xBounds(graph);
    const scale = (graphWidth(graph) - 12) / Math.max(1, bounds.max - bounds.min);
    return 6 + (x - bounds.min) * scale;
  };
  const points = (items: Point[], graph: State['graph']) => items.map(point => `${sx(graph, point.x)},${sy(point.y)}`).join(' ');

  function refs(commit: Commit): string[] {
    return commit.refs.filter(ref => ref.type === 'remote-branch' || ref.type === 'tag').map(ref => ref.name);
  }
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
</script>

<div class="recent-commits">
  <div class="toolbar">
    <select aria-label={t('recent.repoPicker')} value={recent?.repoPath ?? ''} onchange={(event) => request('recentCommitsSelectRepo', { repoPath: (event.currentTarget as HTMLSelectElement).value })}>
      {#each recent?.repos ?? [] as repo (repo.path)}<option value={repo.path}>{repo.name}</option>{/each}
    </select>
    <button class="icon-button" aria-label={t('recent.refresh')} title={t('recent.refresh')} onclick={() => { loading = true; request('recentCommitsRefresh'); }}><i class="codicon codicon-refresh"></i></button>
    <button class="icon-button" aria-label={t('recent.openFullGraph')} title={t('recent.openFullGraph')} onclick={() => request('recentCommitsOpenGraph')}><i class="codicon codicon-graph"></i></button>
  </div>
  {#if recent?.error}
    <div class="message error"><strong>{recent.repoName}</strong><br /><i class="codicon codicon-error"></i>{recent.error}</div>
  {:else if loading}
    <div class="message">{t('recent.loading')}</div>
  {:else if recent && recent.commits.length === 0}
    <div class="message"><strong>{recent.repoName}</strong><br />{t('recent.noCommits')}</div>
  {:else if recent}
    <div class="identity" title={recent.repoPath}><strong>{recent.repoName}</strong><span>{recent.branch ?? recent.scope ?? t('recent.headScope')}</span></div>
    <div class="summary">
      {#if recent.tracking}<span>{t('recent.aheadBehind', { ahead: recent.ahead, behind: recent.behind })}</span>{/if}
      <span>{recent.staged || recent.unstaged || recent.conflicts ? t('recent.changes', { staged: recent.staged, unstaged: recent.unstaged, conflicts: recent.conflicts }) : t('file.noChanges')}</span>
    </div>
    <div class="commit-list" style:padding-left={`${graphWidth(recent.graph)}px`}>
      <div class="graph-layer" aria-hidden="true">
        <svg width={graphWidth(recent.graph)} height={recent.commits.length * 24 + 24} viewBox={`0 0 ${graphWidth(recent.graph)} ${recent.commits.length * 24 + 24}`}>
          {#each recent.graph.paths as graphPath}<polyline class="rail" points={points(graphPath.points, recent.graph)} style={`--c: ${color(graphPath.color, graphPath.colorOverride)}`} fill="none" stroke-width="2" />{/each}
          {#each recent.graph.links as link}<path class="rail" d={`M ${sx(recent.graph, link.start.x)} ${sy(link.start.y)} Q ${sx(recent.graph, link.control.x)} ${sy(link.control.y)} ${sx(recent.graph, link.end.x)} ${sy(link.end.y)}`} style={`--c: ${color(link.color, link.colorOverride)}`} fill="none" stroke-width="2" />{/each}
          {#each recent.graph.dots as dot}<circle class="dot-ring" cx={sx(recent.graph, dot.center.x)} cy={sy(dot.center.y)} r={dot.isHead ? 5 : 3.5} style={`--c: ${color(dot.color, dot.colorOverride)}`} stroke-width={dot.isHead ? 2 : 1.5} />{#if dot.isHead}<circle class="dot-fill" cx={sx(recent.graph, dot.center.x)} cy={sy(dot.center.y)} r="2" style={`--c: ${color(dot.color, dot.colorOverride)}`} />{/if}{/each}
        </svg>
      </div>
      {#each recent.commits as commit (commit.hash)}
        <div class="commit-row" class:head-row={isHead(commit)}>
          {#if isHead(commit)}<span class="head-marker">{t('recent.headMarker')}</span>{/if}
          <span class="commit-hash" title={commit.hash}>{commit.abbreviatedHash}</span>
          <span class="commit-subject" title={commit.subject}>{commit.subject}</span>
          {#each refs(commit).slice(0, 1) as ref}<span class="ref" title={ref}>{ref}</span>{/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#workbench-app) { height: 100%; margin: 0; }
  .recent-commits { height: 100%; box-sizing: border-box; color: var(--vscode-foreground); font: var(--vscode-font-size, 13px) var(--vscode-font-family); padding: 6px 8px 8px; display: flex; flex-direction: column; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 4px; margin-bottom: 5px; }
  select { flex: 1; min-width: 0; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-contrastBorder)); padding: 2px 4px; }
  .icon-button { width: 24px; height: 24px; padding: 0; color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; }
  .icon-button:hover, .icon-button:focus-visible { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .identity, .summary { display: flex; gap: 6px; min-width: 0; align-items: baseline; }
  .identity { justify-content: space-between; font-size: 11px; }
  .identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .identity span, .summary { color: var(--vscode-descriptionForeground); font-size: 10px; }
  .summary { justify-content: space-between; padding: 2px 0 5px; }
  .commit-list { position: relative; flex: 1; min-height: 0; overflow: auto; }
  .graph-layer { position: absolute; inset: 0 auto auto 0; pointer-events: none; }
  .commit-row { position: relative; display: flex; align-items: center; gap: 5px; height: 24px; min-width: 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); }
  .commit-row.head-row { background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 35%, transparent); }
  .head-marker { flex: none; color: var(--vscode-textLink-foreground); font-size: 10px; font-weight: 700; }
  .commit-hash { flex: none; width: 42px; color: var(--vscode-descriptionForeground); font: 10px var(--vscode-editor-font-family); }
  .commit-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref { flex: none; max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-textLink-foreground); font-size: 10px; }
  .message { padding: 10px 4px; color: var(--vscode-descriptionForeground); }
  .message.error { color: var(--vscode-errorForeground); }
  .message .codicon { margin-right: 5px; }
  .graph-layer .rail { stroke: var(--c); stroke-linecap: round; }
  .graph-layer .dot-fill { fill: var(--c); }
  .graph-layer .dot-ring { fill: transparent; stroke: var(--c); }
  :global(body.vscode-light) .graph-layer .rail,
  :global(body.vscode-high-contrast-light) .graph-layer .rail { stroke: color-mix(in oklab, var(--c) 72%, #000); }
  :global(body.vscode-light) .graph-layer .dot-fill,
  :global(body.vscode-high-contrast-light) .graph-layer .dot-fill { fill: color-mix(in oklab, var(--c) 72%, #000); }
  :global(body.vscode-light) .graph-layer .dot-ring,
  :global(body.vscode-high-contrast-light) .graph-layer .dot-ring { stroke: color-mix(in oklab, var(--c) 72%, #000); }
  :global(body.vscode-high-contrast) .graph-layer .rail,
  :global(body.vscode-high-contrast-light) .graph-layer .rail { stroke-width: 2.5; }
</style>
