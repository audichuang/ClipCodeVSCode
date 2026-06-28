import type { Commit, GraphNode, CommitGraphData, GraphPathData, GraphLinkData, GraphDotData } from '../types';

class CommitStore {
  commits = $state<Commit[]>([]);
  graphNodes = $state<GraphNode[]>([]);
  paths = $state<GraphPathData[]>([]);
  links = $state<GraphLinkData[]>([]);
  dots = $state<GraphDotData[]>([]);
  commitLeftMargin = $state<number[]>([]);
  loading = $state(false);
  loadingMore = $state(false);
  hasMore = $state(false);
  currentLimit = $state(0);
  notGitRepo = $state(false);

  // Hash → entry maps derived from the arrays so they auto-rebuild whether
  // callers replace via setData() or assign `commits` / `graphNodes`
  // directly (the latter happens in tests and in some webview flows).
  // O(1) lookups replace the previous O(N) Array.find().
  private commitByHash = $derived.by(() => {
    const m = new Map<string, Commit>();
    for (const c of this.commits) m.set(c.hash, c);
    return m;
  });

  private nodeByHash = $derived.by(() => {
    const m = new Map<string, GraphNode>();
    for (const n of this.graphNodes) m.set(n.commit, n);
    return m;
  });

  setData(data: CommitGraphData) {
    this.commits = data.commits;
    this.graphNodes = data.graph;
    this.paths = data.paths ?? [];
    this.links = data.links ?? [];
    this.dots = data.dots ?? [];
    this.commitLeftMargin = data.commitLeftMargin ?? [];
    this.hasMore = data.hasMore ?? false;
    if (data.currentLimit) this.currentLimit = data.currentLimit;
    this.loading = false;
    this.loadingMore = false;
    this.notGitRepo = false;
  }

  setLoading(value: boolean) {
    this.loading = value;
  }

  setLoadingMore(value: boolean) {
    this.loadingMore = value;
  }

  getCommit(hash: string): Commit | undefined {
    return this.commitByHash.get(hash);
  }

  // Read-only hash→Commit map for callers that need bulk lookups (e.g. squash
  // chain validation). Backed by the same derived map as getCommit().
  get commitMap(): ReadonlyMap<string, Commit> {
    return this.commitByHash;
  }

  // Recomputed only when commits changes, not on every access (it's read from
  // several places in CommitGraph). Keys off the `head` ref so it works for
  // detached HEAD too; null when no loaded commit is HEAD (e.g. filtered out).
  private _headHash = $derived.by<string | null>(() => {
    for (const c of this.commits) {
      if (c.refs.some((r) => r.type === 'head')) return c.hash;
    }
    return null;
  });

  /** Hash of the loaded commit currently at HEAD. */
  get headHash(): string | null {
    return this._headHash;
  }

  getGraphNode(hash: string): GraphNode | undefined {
    return this.nodeByHash.get(hash);
  }
}

export const commitStore = new CommitStore();
