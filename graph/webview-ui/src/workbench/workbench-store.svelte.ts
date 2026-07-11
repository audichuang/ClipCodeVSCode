// Webview-side mirror of the host status/selection shapes (kept inline so the
// webview never imports host code — same convention as message-bus's
// snipcodeCopyFullSource). Selection is pure webview state (no git calls).

export interface WbFileChange {
  path: string;
  changeType: string;
  hunkCount: number;
  hunkable: boolean;
}
export interface WbRepoStatus {
  repoPath: string;
  repoName: string;
  files: WbFileChange[];
  operationState: string;
  indexDirty: boolean;
  detached: boolean;
  commitDisabledReason: string | null;
}
export interface WbStatus { repos: WbRepoStatus[]; }
export interface WbCommitResult { repoPath: string; ok: boolean; newHead?: string; error?: string; }
export interface WbSelection { repoPath: string; files: Array<{ path: string; hunkCount: number }>; }

type TriState = 'all' | 'some' | 'none';

class WorkbenchStore {
  repos = $state<WbRepoStatus[]>([]);
  // repoPath → Set of checked file paths.
  private checked = $state<Record<string, Set<string>>>({});
  collapsed = $state<Record<string, boolean>>({});
  message = $state('');
  committing = $state(false);

  reset(): void {
    this.repos = [];
    this.checked = {};
    this.collapsed = {};
    this.message = '';
    this.committing = false;
  }

  setStatus(status: WbStatus): void {
    this.repos = status.repos;
    // Drop checks for files/repos that no longer exist; keep the rest.
    const next: Record<string, Set<string>> = {};
    for (const repo of status.repos) {
      const prev = this.checked[repo.repoPath];
      if (!prev) continue;
      const paths = new Set(repo.files.map((f) => f.path));
      const kept = new Set([...prev].filter((p) => paths.has(p)));
      if (kept.size) next[repo.repoPath] = kept;
    }
    this.checked = next;
  }

  private repo(repoPath: string): WbRepoStatus | undefined {
    return this.repos.find((r) => r.repoPath === repoPath);
  }
  private disabled(repoPath: string): boolean {
    return this.repo(repoPath)?.commitDisabledReason != null;
  }

  toggleFile(repoPath: string, path: string): void {
    if (this.disabled(repoPath)) return;
    const set = new Set(this.checked[repoPath] ?? []);
    if (set.has(path)) set.delete(path); else set.add(path);
    this.checked = { ...this.checked, [repoPath]: set };
  }

  toggleRepo(repoPath: string): void {
    if (this.disabled(repoPath)) return;
    const repo = this.repo(repoPath);
    if (!repo) return;
    const state = this.repoTriState(repoPath);
    const set = state === 'all' ? new Set<string>() : new Set(repo.files.map((f) => f.path));
    this.checked = { ...this.checked, [repoPath]: set };
  }

  toggleCollapse(repoPath: string): void {
    this.collapsed = { ...this.collapsed, [repoPath]: !this.collapsed[repoPath] };
  }

  isChecked(repoPath: string, path: string): boolean {
    return this.checked[repoPath]?.has(path) ?? false;
  }

  repoTriState(repoPath: string): TriState {
    const repo = this.repo(repoPath);
    const set = this.checked[repoPath];
    if (!repo || !set || set.size === 0) return 'none';
    return set.size === repo.files.length ? 'all' : 'some';
  }

  selections(): WbSelection[] {
    const out: WbSelection[] = [];
    for (const repo of this.repos) {
      const set = this.checked[repo.repoPath];
      if (!set || set.size === 0) continue;
      out.push({
        repoPath: repo.repoPath,
        files: repo.files
          .filter((f) => set.has(f.path))
          .map((f) => ({ path: f.path, hunkCount: f.hunkCount })),
      });
    }
    return out;
  }

  get canCommit(): boolean {
    return this.selections().length > 0 && !this.committing;
  }
  get canAmend(): boolean {
    // Amend only when the whole selection is inside a single repo.
    return this.selections().length === 1 && !this.committing;
  }

  applyCommitResults(results: WbCommitResult[]): void {
    const next = { ...this.checked };
    for (const r of results) {
      if (r.ok) delete next[r.repoPath]; // succeeded → clear selection
      // failed → keep selection (avoid double-commit on retry)
    }
    this.checked = next;
    this.committing = false;
  }
}

export const workbenchStore = new WorkbenchStore();
