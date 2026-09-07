import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, type StatusChange } from '../git/git-service';
/* SNIPCODE-HOOK start: Batch D retain disambiguated repo names */
import { RepoDiscoveryService, type RepoInfo } from '../services/repo-discovery';
/* SNIPCODE-HOOK end */
import { runExclusive } from '../services/mutation-coordinator';
import { triggerVSCodeGitAuth } from '../git/vscode-git-bridge';
import { readTimeoutMs } from '../utils/config';
import { ChangesTreeProvider, type ChangeTreeNode } from './changes-tree';
import type { RepoStatus, FileNode, RepoNode, ChangeGroup } from './build-change-tree';
import type { DiffData } from '../git/types';
import type { DiffPanel } from '../panels/DiffPanel';

export interface CommitResult { repoName: string; ok: boolean; error?: string }

/* SNIPCODE-HOOK start: bounded per-repo status fan-out
   Measured (25 × 8k-file repos, Linux): serial 212ms → pool 95–103ms at any
   limit from 4 to unbounded, so the limit is not about speed here — it caps the
   simultaneous git processes (3 per repo) on hosts where spawning is expensive.
   ponytail: one shared limit; make it a setting only if a real workspace needs it. */
const STATUS_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` in flight (sliding window, not
 *  batches — a slow item never holds up the ones behind it). The first
 *  rejection stops new work and rejects the whole call, which is how the
 *  strict (commit) read keeps its veto semantics. */
async function forEachWithLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (err) { failed = true; throw err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/* SNIPCODE-HOOK end */

/**
 * Host owner of the Snipcode Git commit workbench (tree + commit box). Discovers
 * repos, loads real staged/unstaged status for the tree, and runs the real git
 * staging ops (stage / unstage / commit the index) under the per-repo mutation
 * lock. The tree paints Staged/Unstaged → repo → file; the commit box (a webview)
 * calls commit() with one shared message across every repo that has staged work.
 */
export class ChangesWorkbench implements vscode.Disposable {
  readonly tree: ChangesTreeProvider;
  private readonly svcs = new Map<string, GitService>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** null = show every repo; a Set restricts the tree (and stage/commit-all) to
   *  the chosen repo paths. Set via the "Filter Repos" command. */
  private repoFilter: Set<string> | null = null;
  private view: vscode.TreeView<unknown> | undefined;
  /** Staged repos the user UNCHECKED (default = every staged repo is committed). */
  private readonly uncheckedForCommit = new Set<string>();
  private diffPanel: DiffPanel | undefined;

  constructor() {
    this.tree = new ChangesTreeProvider(
      /* SNIPCODE-HOOK start: progressive first paint — the tree gets each repo as it lands */
      (onPartial) => this.loadStatus(false, this.uncheckedForCommit, onPartial),
      /* SNIPCODE-HOOK end */
      (repoPath) => !this.uncheckedForCommit.has(repoPath),
    );
  }

  /** Lets the workbench show the active filter in the tree's message bar. */
  setView(view: vscode.TreeView<unknown>): void { this.view = view; }

  /** Wire the Diff editor-tab panel so file clicks and post-stage refreshes can drive it. */
  setDiffPanel(panel: DiffPanel): void { this.diffPanel = panel; }

  /** Wired to TreeView.onDidChangeCheckboxState in extension.ts. */
  handleCheckboxChange(items: ReadonlyArray<readonly [ChangeTreeNode, vscode.TreeItemCheckboxState]>): void {
    for (const [node, state] of items) {
      if (node.kind !== 'repo') continue;
      if (state === vscode.TreeItemCheckboxState.Unchecked) this.uncheckedForCommit.add(node.repoPath);
      else this.uncheckedForCommit.delete(node.repoPath);
    }
    /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
    this.tree.notifyCommitSelectionChanged();
    /* SNIPCODE-HOOK end */
  }

  /** Built-in vscode.git askpass env (same source MainPanel uses); set from
   *  extension.ts so toolbar fetch/pull/push hit the normal credential flow. */
  private gitEnv: Record<string, string> | undefined;
  setGitEnv(env: Record<string, string>): void {
    this.gitEnv = env;
    for (const svc of this.svcs.values()) { svc.setExtraEnv(env); }
  }

  private svcFor(repoPath: string): GitService {
    let svc = this.svcs.get(repoPath);
    if (!svc) {
      svc = new GitService(repoPath);
      // Same wiring as MainPanel.createGitService: askpass env, auth retry via
      // the built-in git prompt (GIT_TERMINAL_PROMPT=0 would otherwise turn a
      // missing credential into a hard failure), and the user's timeout.
      if (this.gitEnv) { svc.setExtraEnv(this.gitEnv); }
      svc.setAuthRetryHandler((remote) => triggerVSCodeGitAuth(repoPath, remote));
      svc.setDefaultTimeout(readTimeoutMs());
      this.svcs.set(repoPath, svc);
    }
    return svc;
  }

  /* SNIPCODE-HOOK start: Batch D retain disambiguated repo names */
  private async discoverUnfiltered(): Promise<RepoInfo[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    return RepoDiscoveryService.discoverRepos(folders).catch(() => []);
  }

  private async discover(): Promise<RepoInfo[]> {
    const found = await this.discoverUnfiltered();
    return this.repoFilter ? found.filter(r => this.repoFilter!.has(r.path)) : found;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: two-stage discovery for the status read
     The fast pass (workspace roots + their direct children) is every repo in
     the common layouts and lands in ~25ms; the deep walk + submodule scan
     behind it took 1.0–1.4s inside a live VS Code at 25 roots (measured). `fast`
     resolves on that first snapshot — or on the full result when there is none
     (cache hit) — so status reads start without waiting for the walk. */
  private discoverTwoStage(): { fast: Promise<RepoInfo[]>; full: Promise<RepoInfo[]> } {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const filtered = (found: RepoInfo[]) => this.repoFilter ? found.filter(r => this.repoFilter!.has(r.path)) : found;
    let onFastPass!: (repos: RepoInfo[]) => void;
    const fastPass = new Promise<RepoInfo[]>(resolve => { onFastPass = resolve; });
    const full = RepoDiscoveryService.discoverRepos(folders, onFastPass).catch(() => [] as RepoInfo[]).then(filtered);
    return { fast: Promise.race([fastPass.then(filtered), full]), full };
  }
  /* SNIPCODE-HOOK end */

  /** Discover repos (respecting the filter) and read each one's status + branch. */
  /* SNIPCODE-HOOK start: Batch D commit status-read guard */
  private async loadStatus(
    strict = false,
    uncheckedSnapshot: ReadonlySet<string> = this.uncheckedForCommit,
    /* SNIPCODE-HOOK start: progressive multi-repo status
       Repos used to be read one after another and the tree painted only when the
       LAST one answered: 25 repos = 25 × (slowest of status/branch/rev-list),
       and one repo on a slow disk held the other 24 hostage. Now a bounded pool
       reads them concurrently and `onPartial` hands the caller the repos that
       have answered so far (in discovery order) so the tree can paint them
       without waiting for the stragglers. */
    onPartial?: (partial: RepoStatus[]) => void,
  ): Promise<RepoStatus[]> {
    const { fast, full } = this.discoverTwoStage();
    const statuses = new Map<string, RepoStatus>();
    let known: RepoInfo[] = await fast;
    const read = (repos: RepoInfo[]) => forEachWithLimit(repos, STATUS_CONCURRENCY, async (r) => {
      statuses.set(r.path, await this.readRepoStatus(r, strict, uncheckedSnapshot));
      onPartial?.(known.flatMap(k => statuses.has(k.path) ? [statuses.get(k.path)!] : []));
    });
    await read(known);
    known = await full;
    await read(known.filter(r => !statuses.has(r.path)));
    // Names from the full list: the deep walk may have disambiguated a duplicate
    // basename that the fast pass still reported bare.
    return known.map(r => ({ ...statuses.get(r.path)!, repoName: r.name }));
  }

  private async readRepoStatus(r: RepoInfo, strict: boolean, uncheckedSnapshot: ReadonlySet<string>): Promise<RepoStatus> {
    /* SNIPCODE-HOOK end */
    const svc = this.svcFor(r.path);
    const [diff, branches, aheadBehind] = await Promise.all([
      svc.getUncommittedDiff().catch(err => {
        // Strict (= commit) only vetoes for repos still checked for commit:
        // an unreadable repo the user excluded must not block the others.
        // The caller passes a SNAPSHOT of the checkbox state so a mid-commit
        // recheck cannot desynchronise this veto from the final filter.
        if (strict && !uncheckedSnapshot.has(r.path)) {
          throw new Error(`${r.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        /* SNIPCODE-HOOK start: S12 a read failure stays visible instead of vanishing */
        const message = err instanceof Error ? err.message : String(err);
        return { staged: [], unstaged: [], conflict: [], error: message };
        /* SNIPCODE-HOOK end */
      }),
      svc.branches().catch(() => []),
      svc.aheadBehind(), // never throws; null when no upstream
    ]);
    const current = branches.find(b => b.current);
    const branch = current?.detached ? 'HEAD (detached)' : (current?.name ?? '(no branch)');
    return {
      repoName: r.name, repoPath: r.path, branch,
      ahead: aheadBehind?.ahead, behind: aheadBehind?.behind,
      staged: diff.staged, unstaged: diff.unstaged,
      /* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
      conflict: diff.conflict ?? [],
      /* SNIPCODE-HOOK end */
      /* SNIPCODE-HOOK start: S12 a read failure stays visible instead of vanishing */
      error: (diff as { error?: string }).error,
      /* SNIPCODE-HOOK end */
    };
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
  async refresh(): Promise<void> {
    /* SNIPCODE-HOOK start: S12 show progress in the Changes view while refreshing */
    await vscode.window.withProgress({ location: { viewId: 'snipcode.changes' } }, () => this.tree.refresh());
    /* SNIPCODE-HOOK end */
    this.diffPanel?.invalidateIndexDocuments();
    /* SNIPCODE-HOOK start: S P2 activity-bar badge = staged repo count */
    if (this.view) {
      const count = this.tree.getStagedRepoCount();
      /* SNIPCODE-HOOK start: X1-4 badge tooltip through l10n */
      this.view.badge = count > 0 ? { value: count, tooltip: vscode.l10n.t('{0} repo(s) awaiting commit', String(count)) } : undefined;
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK end */
  }
  /* SNIPCODE-HOOK end */

  /** Toolbar one-click ops across ALL repos (IntelliJ 更新專案 style): run `op`
   *  per repo sequentially with progress; ONE repo failing must not stop the
   *  rest — failures/skips are collected and reported once at the end. Network
   *  ops don't take GitService's mutation lock; runExclusive only keeps them
   *  from interleaving with this extension's own queued operations. */
  private async forAllRepos(verb: string, op: (svc: GitService) => Promise<unknown>): Promise<void> {
    // "All Repos" means ALL: the tree's Filter Repos scope is a display scope
    // (IntelliJ semantics) and must not silently exclude repos from sync.
    const repos = await this.discoverUnfiltered();
    if (repos.length === 0) {
      /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
      void vscode.window.showInformationMessage(vscode.l10n.t('No git repositories in workspace'));
      /* SNIPCODE-HOOK end */
      return;
    }
    const failures: string[] = [];
    const skipped: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: verb },
      async (progress) => {
        for (const [i, r] of repos.entries()) {
          /* SNIPCODE-HOOK start: Batch D retain disambiguated repo names */
          const name = r.name;
          /* SNIPCODE-HOOK end */
          progress.report({ message: `${name} (${i + 1}/${repos.length})`, increment: 100 / repos.length });
          try {
            const res = await runExclusive(r.path, () => op(this.svcFor(r.path)));
            if ((res as { pushed?: boolean })?.pushed === false) {
              /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
              skipped.push(vscode.l10n.t('{0}: no remote, skipped', name));
              /* SNIPCODE-HOOK end */
            }
          } catch (err) {
            failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    );
    await this.refresh();
    const ok = repos.length - failures.length - skipped.length;
    /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
    if (failures.length > 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('{0}: {1}/{2} succeeded; {3}', verb, String(ok), String(repos.length), [...failures, ...skipped].join('; ')),
      );
    } else if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0}: {1}/{2} succeeded; {3}', verb, String(ok), String(repos.length), skipped.join('; ')),
      );
    } else {
      vscode.window.setStatusBarMessage(`${verb} ✓ (${repos.length} repos)`, 5000);
    }
    /* SNIPCODE-HOOK end */
  }

  async fetchAll(): Promise<void> { return this.forAllRepos('Fetch', (svc) => svc.fetch(undefined, { prune: true })); }
  /** No args on purpose: each repo's own pull.rebase / merge config decides. */
  async pullAll(): Promise<void> { return this.forAllRepos('Pull', (svc) => svc.pull()); }
  async pushAll(): Promise<void> { return this.forAllRepos('Push', (svc) => svc.pushCurrentBranch()); }

  /** Debounced refresh; wired to the FileWatcher in extension.ts. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  /** Group the selected file nodes by repo and run `fn` per repo under its lock. */
  /* SNIPCODE-HOOK start: Batch B retain rename source path */
  private async byRepo(nodes: FileNode[], fn: (svc: GitService, changes: FileNode[]) => Promise<void>): Promise<void> {
    const byRepo = new Map<string, FileNode[]>();
    for (const n of nodes) {
      const list = byRepo.get(n.repoPath) ?? [];
      list.push(n);
      byRepo.set(n.repoPath, list);
    }
    for (const [repoPath, changes] of byRepo) {
      await runExclusive(repoPath, () => fn(this.svcFor(repoPath), changes));
    }
    await this.refresh();
  }

  private stage(nodes: FileNode[]): Promise<void> {
    return this.byRepo(nodes, (svc, changes) => svc.stagePaths(changes));
  }
  private unstage(nodes: FileNode[]): Promise<void> {
    return this.byRepo(nodes, (svc, changes) => svc.unstagePaths(changes));
  }
  /* SNIPCODE-HOOK end */

  /** Stage every file of one repo (the repo node under Unstaged). */
  private async stageRepo(node: RepoNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: Batch B retain rename source path */
    /* SNIPCODE-HOOK start: R4/S7 never `git add` an unregistered nested repo dir */
    const files = node.files.filter(f => f.status !== 'N');
    /* SNIPCODE-HOOK end */
    if (files.length) await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).stagePaths(files));
    /* SNIPCODE-HOOK end */
    await this.refresh();
  }
  /** Unstage every file of one repo (the repo node under Staged). */
  private async unstageRepo(node: RepoNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: Batch B retain rename source path */
    if (node.files.length) await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).unstagePaths(node.files));
    /* SNIPCODE-HOOK end */
    await this.refresh();
  }

  /* SNIPCODE-HOOK start: S4 Discard working-tree changes (file + repo layers) */
  /** Revert the working-tree edits for the selected unstaged file(s) — tracked
   *  paths restore from the index, untracked paths are deleted. Destructive and
   *  unrecoverable, so it always confirms via a modal warning first. */
  private async discard(nodes: FileNode[]): Promise<void> {
    if (nodes.length === 0) return;
    /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
    const label = nodes.length === 1 ? nodes[0].path : vscode.l10n.t('{0} files', String(nodes.length));
    const discardLabel = vscode.l10n.t('Discard');
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t('Discard changes to {0}? This cannot be undone.', label),
      { modal: true },
      discardLabel,
    );
    if (confirmed !== discardLabel) return;
    /* SNIPCODE-HOOK end */
    await this.byRepo(nodes, (svc, changes) => svc.discardPaths(changes));
  }

  /** Discard every unstaged file of one repo (the repo node under Unstaged). */
  private async discardRepo(node: RepoNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    const files = node.files.filter(f => f.status !== 'N');
    if (files.length === 0) return;
    /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
    const discardLabel = vscode.l10n.t('Discard');
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t('Discard changes to {0} file(s) in {1}? This cannot be undone.', String(files.length), node.repoName),
      { modal: true },
      discardLabel,
    );
    if (confirmed !== discardLabel) return;
    /* SNIPCODE-HOOK end */
    await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).discardPaths(files));
    await this.refresh();
  }
  /* SNIPCODE-HOOK end */

  /** Flatten any selected node(s) — file, repo, or group — to their file nodes. */
  private nodeFiles(node: ChangeTreeNode): FileNode[] {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return [];
    /* SNIPCODE-HOOK end */
    if (node.kind === 'file') return [node];
    if (node.kind === 'repo') return node.files;
    return node.repos.flatMap(r => r.files); // group → every repo's files
  }

  /** Copy the selected changes (file / repo / group) as a ClipCode payload,
   *  de-duplicated. Reuses the root extension's copy command. Copy-the-diff is B-2b. */
  private async copyAsClipCode(nodes: ChangeTreeNode[]): Promise<void> {
    const seen = new Set<string>();
    /* SNIPCODE-HOOK start: Batch D staged copy uses the index snapshot */
    const resources: Array<{ resourceUri: vscode.Uri; group: ChangeGroup }> = [];
    for (const n of nodes.flatMap(x => this.nodeFiles(x))) {
      const fsPath = path.join(n.repoPath, n.path);
      if (seen.has(fsPath)) continue;
      seen.add(fsPath);
      resources.push({ resourceUri: vscode.Uri.file(fsPath), group: n.group });
    }
    if (resources.length) await vscode.commands.executeCommand('clipcode.copyGitChanges', resources);
    /* SNIPCODE-HOOK end */
  }

  /** Stage every currently-unstaged file across all repos (re-reads live status
   *  so a file created since the last paint is not missed). */
  private async stageAll(): Promise<void> {
    for (const r of await this.loadStatus()) {
      /* SNIPCODE-HOOK start: Batch B retain rename source path */
      /* SNIPCODE-HOOK start: R4/S7 never `git add` an unregistered nested repo dir */
      const unstaged = r.unstaged.filter(f => f.status !== 'N');
      /* SNIPCODE-HOOK end */
      if (unstaged.length) await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).stagePaths(unstaged));
      /* SNIPCODE-HOOK end */
    }
    await this.refresh();
  }
  private async unstageAll(): Promise<void> {
    for (const r of await this.loadStatus()) {
      /* SNIPCODE-HOOK start: Batch B retain rename source path */
      if (r.staged.length) await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).unstagePaths(r.staged));
      /* SNIPCODE-HOOK end */
    }
    await this.refresh();
  }

  /** Commit every repo that has staged changes with one shared message. amend is
   *  only allowed when exactly one repo has staged work (rewrites that HEAD). */
  async commit(message: string, amend: boolean): Promise<CommitResult[]> {
    if (!this.isCommitScopeReady()) {
      throw new Error(vscode.l10n.t('Commit is unavailable while repositories are still loading'));
    }
    // Only repos with staged work AND left checked in the tree are committed.
    /* SNIPCODE-HOOK start: Batch D commit status-read guard */
    // One immutable snapshot of the checkbox state for the whole commit: the
    // strict veto and the filter below must see the same selection even if the
    // user toggles checkboxes while status reads are in flight.
    const unchecked = new Set(this.uncheckedForCommit);
    const candidates = (await this.loadStatus(true, unchecked))
      .filter(r => r.staged.length > 0 && !unchecked.has(r.repoPath));
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: R3/S3 skip repos with unresolved conflicts instead of
       letting `git commit` fail opaquely with "unmerged files" */
    const blocked = candidates.filter(r => r.conflict.length > 0);
    const status = candidates.filter(r => r.conflict.length === 0);
    if (blocked.length > 0 && this.view) {
      /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
      this.view.message = vscode.l10n.t('Skipped repo(s) with unresolved conflicts: {0}', blocked.map(r => r.repoName).join(', '));
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: live-QA-3 name the real reason when conflicts are it.
       Everything checked was filtered out just above, so the generic "nothing
       staged" text contradicted what the user could see: their repo WAS checked
       and DID have staged files. The tree message alone (set above) is easy to
       miss — it sits in a different surface from the error toast. */
    if (status.length === 0 && blocked.length > 0) {
      throw new Error(vscode.l10n.t(
        'Cannot commit: unresolved conflicts in {0}. Resolve them, then stage the files.',
        blocked.map(r => r.repoName).join(', '),
      ));
    }
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
    if (status.length === 0) throw new Error(vscode.l10n.t('No repo checked to commit (or nothing staged)'));
    /* SNIPCODE-HOOK end */
    if (amend && status.length > 1) throw new Error('amend can only target a single repo');
    const results: CommitResult[] = [];
    for (const r of status) {
      try {
        await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).commitIndex(message, { amend }));
        /* SNIPCODE-HOOK start: refresh an already-open matching Diff tab after
           a successful commit; unrelated tabs stay untouched. */
        for (const file of r.staged) this.diffPanel?.refreshIfCurrent(r.repoPath, file.path);
        /* SNIPCODE-HOOK end */
        results.push({ repoName: r.repoName, ok: true });
      } catch (err) {
        results.push({ repoName: r.repoName, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.refresh();
    return results;
  }

  /* SNIPCODE-HOOK start: S13 Amend prefill */
  isCommitScopeReady(): boolean { return this.tree.isCommitScopeReady(); }

  /* SNIPCODE-HOOK start: failed status read, not a slow one */
  isCommitScopeFailed(): boolean { return this.tree.isCommitScopeFailed(); }
  /* SNIPCODE-HOOK end */

  /** HEAD's commit message for the single checked+staged repo, so the commit
   *  box can prefill an empty Amend textarea (webview asks for this on demand
   *  rather than the tree pushing it on every refresh). Returns null when
   *  amend wouldn't have exactly one target (same rule as commit()). */
  async amendPrefillMessage(): Promise<string | null> {
    if (!this.isCommitScopeReady()) return null;
    const candidates = (await this.loadStatus())
      .filter(r => r.staged.length > 0 && !this.uncheckedForCommit.has(r.repoPath) && r.conflict.length === 0);
    if (candidates.length !== 1) return null;
    return this.svcFor(candidates[0].repoPath).headCommitMessage();
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S9 inline "Open in Editor" opens the plain file, not a diff */
  /** The inline go-to-file icon: open the file itself, not VS Code's own diff
   *  view (that was a silent second diff UI alongside the Snipcode Diff tab —
   *  see S9 in the sidebar audit). The native diff is still reachable via the
   *  "Open Changes (VS Code)" context-menu entry, openChangeNative below. */
  private async openChange(node: FileNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    const uri = vscode.Uri.file(path.join(node.repoPath, node.path));
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  /** Read uncommitted status (staged/unstaged/conflict) for a repo. */
  async uncommittedStatus(repoPath: string): Promise<{ staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }> {
    return this.svcFor(repoPath).getUncommittedDiff();
  }

  /** Check if a repo has a HEAD commit (false for unborn branch / empty repo). */
  async hasHead(repoPath: string): Promise<boolean> {
    return this.svcFor(repoPath).hasHead();
  }

  /** Right-click-only: VS Code's built-in diff view for this change. */
  private async openChangeNative(node: FileNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    await this.openNativeDiff(node);
  }

  /** Open native diff for a file node using Snipcode's own content provider. */
  async openNativeDiff(node: FileNode, line?: number): Promise<void> {
    if (!this.diffPanel) return;
    const side = node.group === 'staged' ? 'staged' : 'unstaged';
    await this.diffPanel.openNativeDiff(node.repoPath, node.path, side, line);
  }
  /* SNIPCODE-HOOK end */

  /** Read a file's parsed DiffData (staged or unstaged side) for the Diff panel.
   *  Reuses getUncommittedFileDiff so the hunk order aligns with the raw
   *  stageHunks/unstageHunks re-fetch (same git diff command per side).
   *  Throws on git failure — null strictly means "this side has no diff",
   *  so the panel can tell an error apart from an empty state. */
  /* SNIPCODE-HOOK start: live-QA-2 no oldPath argument — GitService resolves the
     rename source for THIS side from git status; a caller here would only know
     the side the user happened to click. */
  async fileDiffData(repoPath: string, file: string, side: ChangeGroup): Promise<DiffData | null> {
    return this.svcFor(repoPath).getUncommittedFileDiff(file, side === 'staged');
  }
  /* SNIPCODE-HOOK end */

  /** Image bytes at a ref for the Diff tab's ImageDiff ('working' is handled by
   *  the panel itself — this only serves real git refs like 'HEAD' / ':0'). */
  async imageBase64(repoPath: string, ref: string, file: string): Promise<string> {
    return this.svcFor(repoPath).getImageBase64(ref, file);
  }

  /** Full text content at a ref ('' = index) for the Diff tab's open-in-editor view. */
  async fileAtRef(repoPath: string, ref: string, file: string): Promise<string> {
    return this.svcFor(repoPath).getFileAtRef(ref, file);
  }

  /** Drive the Diff editor tab from a clicked file node (tree command). */
  private async showInDiffView(node: FileNode): Promise<void> {
    /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
    if (!node) return;
    /* SNIPCODE-HOOK end */
    const defaultViewer = vscode.workspace.getConfiguration('snipcode.changes').get<string>('defaultDiffViewer', 'tab');
    if (defaultViewer === 'native') {
      await this.openNativeDiff(node);
      return;
    }
    /* SNIPCODE-HOOK start: live-QA-2 the clicked node's oldPath is deliberately
       NOT forwarded: it belongs to one side, and the Diff tab shows both. */
    this.diffPanel?.show(node.repoPath, node.path);
    /* SNIPCODE-HOOK end */
  }

  /** Stage the selected hunks of one unstaged file, then refresh the tree and
   *  re-render the file's (now smaller) unstaged diff in the panel. */
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  async stageHunks(repoPath: string, file: string, hunkIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageHunks(file, hunkIndices, fingerprint));
    /* SNIPCODE-HOOK start: perf — re-render the panel BEFORE the tree.
       `refresh()` re-reads status for every repo in the workspace (~100ms at 25
       repos) and the Diff tab's busy gate only releases when its own push
       lands, so waiting for the tree charged every hunk click the whole pool.
       The panel's read needs nothing from the tree: the mutation ran under
       runExclusive and exec() already dropped this repo's read cache. */
    // Only re-render if the user is still on this file — a slow apply must not
    // yank the panel back after they navigated elsewhere.
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
    await this.refresh();
    /* SNIPCODE-HOOK end */
  }

  /** Unstage the selected hunks of one staged file, then refresh + re-render the
   *  file's remaining staged diff. */
  async unstageHunks(repoPath: string, file: string, hunkIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageHunks(file, hunkIndices, fingerprint));
    /* SNIPCODE-HOOK start: perf — panel before tree, see stageHunks */
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
    await this.refresh();
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage, mirrors stageHunks. */
  /** Stage the selected changed lines of one hunk of an unstaged file. */
  async stageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageLines(file, hunkIndex, lineIndices, fingerprint));
    /* SNIPCODE-HOOK start: perf — panel before tree, see stageHunks */
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
    await this.refresh();
    /* SNIPCODE-HOOK end */
  }

  /** Unstage the selected changed lines of one hunk of a staged file. */
  async unstageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageLines(file, hunkIndex, lineIndices, fingerprint));
    /* SNIPCODE-HOOK start: perf — panel before tree, see stageHunks */
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
    await this.refresh();
    /* SNIPCODE-HOOK end */
  }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

  /** Multi-select which repos the Changes tree shows. Picking all (or none)
   *  clears the filter back to "show every repo". */
  private async filterRepos(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const all = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    if (all.length === 0) {
      /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
      void vscode.window.showInformationMessage(vscode.l10n.t('No git repo detected'));
      /* SNIPCODE-HOOK end */
      return;
    }
    const items = all.map(r => ({
      /* SNIPCODE-HOOK start: Batch D retain disambiguated repo names */
      label: r.name,
      /* SNIPCODE-HOOK end */
      description: r.path,
      repoPath: r.path,
      picked: this.repoFilter ? this.repoFilter.has(r.path) : true,
    }));
    /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t('Snipcode Git: which repos to show'),
      placeHolder: vscode.l10n.t('Check the repos to show (all checked = show all)'),
    });
    /* SNIPCODE-HOOK end */
    if (picked === undefined) return; // cancelled — keep current filter
    // All (or nothing) selected → no filter; otherwise restrict to the picks.
    this.repoFilter = picked.length === 0 || picked.length === all.length
      ? null
      : new Set(picked.map(p => p.repoPath));
    if (this.view) {
      /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
      this.view.message = this.repoFilter
        ? vscode.l10n.t('Filtered: {0} / {1} repos', String(this.repoFilter.size), String(all.length))
        : undefined;
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK start: S P2 filter enabled state drives the title-bar icon */
    void vscode.commands.executeCommand('setContext', 'snipcode.changes.filtered', this.repoFilter !== null);
    /* SNIPCODE-HOOK end */
    await this.refresh();
  }

  registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...a: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    // Tree commands are invoked as (clickedItem, selectedItems[]); with
    // canSelectMany the second arg carries the whole selection (undefined for an
    // inline button, which always acts on its single item).
    const sel = <T>(n: unknown, ns: unknown): T[] =>
      (Array.isArray(ns) && ns.length ? (ns as T[]) : [n as T]);
    /* SNIPCODE-HOOK start: Batch B constrain mixed tree selections */
    const sameGroup = (n: unknown, ns: unknown): FileNode[] => {
      /* SNIPCODE-HOOK start: S10 Command Palette guard — no node arg outside the tree */
      if (!n) return [];
      /* SNIPCODE-HOOK end */
      const clicked = n as FileNode;
      const all = sel<FileNode>(n, ns);
      const kept = all.filter(item =>
        item.repoPath === clicked.repoPath && item.group === clicked.group
        /* SNIPCODE-HOOK start: R4/S7 never `git add` an unregistered nested repo dir */
        && item.status !== 'N'
        /* SNIPCODE-HOOK end */
      );
      // Tell the user what a mixed selection dropped — silently ignoring the
      // other repo/side's items reads as "everything was staged".
      if (kept.length < all.length) {
        /* SNIPCODE-HOOK start: X1-4 host notifications through l10n */
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Skipped {0} selected item(s) from another repo or side', String(all.length - kept.length)));
        /* SNIPCODE-HOOK end */
      }
      return kept;
    };
    reg('snipcode.git.stage', (n, ns) => this.stage(sameGroup(n, ns)));
    reg('snipcode.git.unstage', (n, ns) => this.unstage(sameGroup(n, ns)));
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: R3/S3 mark a conflicted file resolved (= git add) */
    reg('snipcode.git.markResolved', (n, ns) => this.stage(sameGroup(n, ns)));
    /* SNIPCODE-HOOK end */
    reg('snipcode.git.stageRepo', (n) => this.stageRepo(n as RepoNode));
    reg('snipcode.git.unstageRepo', (n) => this.unstageRepo(n as RepoNode));
    /* SNIPCODE-HOOK start: S4 Discard working-tree changes (file + repo layers) */
    reg('snipcode.git.discard', (n, ns) => this.discard(sameGroup(n, ns)));
    reg('snipcode.git.discardRepo', (n) => this.discardRepo(n as RepoNode));
    /* SNIPCODE-HOOK end */
    reg('snipcode.git.stageAll', () => this.stageAll());
    reg('snipcode.git.unstageAll', () => this.unstageAll());
    reg('snipcode.git.refresh', () => this.refresh());
    reg('snipcode.git.fetchAll', () => this.fetchAll());
    reg('snipcode.git.pullAll', () => this.pullAll());
    reg('snipcode.git.pushAll', () => this.pushAll());
    reg('snipcode.git.openChange', (n) => this.openChange(n as FileNode));
    /* SNIPCODE-HOOK start: S9 inline "Open in Editor" opens the plain file, not a diff */
    reg('snipcode.git.openChangeNative', (n) => this.openChangeNative(n as FileNode));
    /* SNIPCODE-HOOK end */
    reg('snipcode.git.showDiff', (n) => this.showInDiffView(n as FileNode));
    reg('snipcode.git.copyAsClipCode', (n, ns) => this.copyAsClipCode(sel<ChangeTreeNode>(n, ns)));
    reg('snipcode.git.filterRepos', () => this.filterRepos());
    /* SNIPCODE-HOOK start: S P2 filter enabled state drives the title-bar icon */
    reg('snipcode.git.filterReposActive', () => this.filterRepos());
    /* SNIPCODE-HOOK end */
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.svcs.clear();
  }
}
