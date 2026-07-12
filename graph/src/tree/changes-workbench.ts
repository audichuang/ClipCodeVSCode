import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/git-service';
import { RepoDiscoveryService } from '../services/repo-discovery';
import { runExclusive } from '../services/mutation-coordinator';
import { ChangesTreeProvider, type ChangeTreeNode } from './changes-tree';
import type { RepoStatus, FileNode, RepoNode, ChangeGroup } from './build-change-tree';
import type { DiffHunk } from '../git/types';
import type { SnipcodeDiffViewProvider } from './diff-view';

export interface CommitResult { repoName: string; ok: boolean; error?: string }

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
  private diffView: SnipcodeDiffViewProvider | undefined;

  constructor() {
    this.tree = new ChangesTreeProvider(
      () => this.loadStatus(),
      (repoPath) => !this.uncheckedForCommit.has(repoPath),
    );
  }

  /** Lets the workbench show the active filter in the tree's message bar. */
  setView(view: vscode.TreeView<unknown>): void { this.view = view; }

  /** Wire the Diff webview so file clicks and post-stage refreshes can drive it. */
  setDiffView(view: SnipcodeDiffViewProvider): void { this.diffView = view; }

  /** Wired to TreeView.onDidChangeCheckboxState in extension.ts. */
  handleCheckboxChange(items: ReadonlyArray<readonly [ChangeTreeNode, vscode.TreeItemCheckboxState]>): void {
    for (const [node, state] of items) {
      if (node.kind !== 'repo') continue;
      if (state === vscode.TreeItemCheckboxState.Unchecked) this.uncheckedForCommit.add(node.repoPath);
      else this.uncheckedForCommit.delete(node.repoPath);
    }
  }

  private svcFor(repoPath: string): GitService {
    let svc = this.svcs.get(repoPath);
    if (!svc) { svc = new GitService(repoPath); this.svcs.set(repoPath, svc); }
    return svc;
  }

  private async discover(): Promise<{ path: string }[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const found = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    return this.repoFilter ? found.filter(r => this.repoFilter!.has(r.path)) : found;
  }

  /** Discover repos (respecting the filter) and read each one's status + branch. */
  private async loadStatus(): Promise<RepoStatus[]> {
    const found = await this.discover();
    const out: RepoStatus[] = [];
    for (const r of found) {
      const svc = this.svcFor(r.path);
      const [diff, branches] = await Promise.all([
        svc.getUncommittedDiff().catch(() => ({ staged: [], unstaged: [] })),
        svc.branches().catch(() => []),
      ]);
      const current = branches.find(b => b.current);
      const branch = current?.detached ? 'HEAD (detached)' : (current?.name ?? '(no branch)');
      out.push({ repoName: path.basename(r.path), repoPath: r.path, branch, staged: diff.staged, unstaged: diff.unstaged });
    }
    return out;
  }

  async refresh(): Promise<void> { await this.tree.refresh(); }

  /** Debounced refresh; wired to the FileWatcher in extension.ts. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  /** Group the selected file nodes by repo and run `fn` per repo under its lock. */
  private async byRepo(nodes: FileNode[], fn: (svc: GitService, paths: string[]) => Promise<void>): Promise<void> {
    const byRepo = new Map<string, string[]>();
    for (const n of nodes) {
      const list = byRepo.get(n.repoPath) ?? [];
      list.push(n.path);
      byRepo.set(n.repoPath, list);
    }
    for (const [repoPath, paths] of byRepo) {
      await runExclusive(repoPath, () => fn(this.svcFor(repoPath), paths));
    }
    await this.refresh();
  }

  private stage(nodes: FileNode[]): Promise<void> {
    return this.byRepo(nodes, (svc, paths) => svc.stagePaths(paths));
  }
  private unstage(nodes: FileNode[]): Promise<void> {
    return this.byRepo(nodes, (svc, paths) => svc.unstagePaths(paths));
  }

  /** Stage every file of one repo (the repo node under Unstaged). */
  private async stageRepo(node: RepoNode): Promise<void> {
    const paths = node.files.map(f => f.path);
    if (paths.length) await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).stagePaths(paths));
    await this.refresh();
  }
  /** Unstage every file of one repo (the repo node under Staged). */
  private async unstageRepo(node: RepoNode): Promise<void> {
    const paths = node.files.map(f => f.path);
    if (paths.length) await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).unstagePaths(paths));
    await this.refresh();
  }

  /** Flatten any selected node(s) — file, repo, or group — to their file nodes. */
  private nodeFiles(node: ChangeTreeNode): FileNode[] {
    if (node.kind === 'file') return [node];
    if (node.kind === 'repo') return node.files;
    return node.repos.flatMap(r => r.files); // group → every repo's files
  }

  /** Copy the selected changes (file / repo / group) as a ClipCode payload,
   *  de-duplicated. Reuses the root extension's copy command. Copy-the-diff is B-2b. */
  private async copyAsClipCode(nodes: ChangeTreeNode[]): Promise<void> {
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const n of nodes.flatMap(x => this.nodeFiles(x))) {
      const fsPath = path.join(n.repoPath, n.path);
      if (seen.has(fsPath)) continue;
      seen.add(fsPath);
      uris.push(vscode.Uri.file(fsPath));
    }
    if (uris.length) await vscode.commands.executeCommand('clipcode.copyToClipboard', uris[0], uris);
  }

  /** Stage every currently-unstaged file across all repos (re-reads live status
   *  so a file created since the last paint is not missed). */
  private async stageAll(): Promise<void> {
    for (const r of await this.loadStatus()) {
      if (r.unstaged.length) await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).stagePaths(r.unstaged.map(e => e.path)));
    }
    await this.refresh();
  }
  private async unstageAll(): Promise<void> {
    for (const r of await this.loadStatus()) {
      if (r.staged.length) await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).unstagePaths(r.staged.map(e => e.path)));
    }
    await this.refresh();
  }

  /** Commit every repo that has staged changes with one shared message. amend is
   *  only allowed when exactly one repo has staged work (rewrites that HEAD). */
  async commit(message: string, amend: boolean): Promise<CommitResult[]> {
    // Only repos with staged work AND left checked in the tree are committed.
    const status = (await this.loadStatus())
      .filter(r => r.staged.length > 0 && !this.uncheckedForCommit.has(r.repoPath));
    if (status.length === 0) throw new Error('沒有勾選要提交的 repo（或沒有已暫存的變更）');
    if (amend && status.length > 1) throw new Error('amend can only target a single repo');
    const results: CommitResult[] = [];
    for (const r of status) {
      try {
        await runExclusive(r.repoPath, () => this.svcFor(r.repoPath).commitIndex(message, { amend }));
        results.push({ repoName: r.repoName, ok: true });
      } catch (err) {
        results.push({ repoName: r.repoName, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.refresh();
    return results;
  }

  private async openChange(node: FileNode): Promise<void> {
    const uri = vscode.Uri.file(path.join(node.repoPath, node.path));
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  /** Read a file's parsed hunks (staged or unstaged side) for the Diff webview.
   *  Reuses getUncommittedFileDiff so the hunk order aligns with the raw
   *  stageHunks/unstageHunks re-fetch (same git diff command per side). */
  async fileDiff(repoPath: string, file: string, side: ChangeGroup): Promise<DiffHunk[]> {
    const diff = await this.svcFor(repoPath)
      .getUncommittedFileDiff(file, side === 'staged')
      .catch(() => null);
    return diff?.hunks ?? [];
  }

  /** Drive the Diff webview from a clicked file node (tree command). */
  private showInDiffView(node: FileNode): void {
    this.diffView?.show(node.repoPath, node.path, node.group);
  }

  /** Stage the selected hunks of one unstaged file, then refresh the tree and
   *  re-render the file's (now smaller) unstaged diff in the panel. */
  async stageHunks(repoPath: string, file: string, hunkIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageHunks(file, hunkIndices));
    await this.refresh();
    this.diffView?.show(repoPath, file, 'unstaged');
  }

  /** Unstage the selected hunks of one staged file, then refresh + re-render the
   *  file's remaining staged diff. */
  async unstageHunks(repoPath: string, file: string, hunkIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageHunks(file, hunkIndices));
    await this.refresh();
    this.diffView?.show(repoPath, file, 'staged');
  }

  /** Multi-select which repos the Changes tree shows. Picking all (or none)
   *  clears the filter back to "show every repo". */
  private async filterRepos(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const all = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    if (all.length === 0) {
      void vscode.window.showInformationMessage('沒有偵測到 git repo');
      return;
    }
    const items = all.map(r => ({
      label: path.basename(r.path),
      description: r.path,
      repoPath: r.path,
      picked: this.repoFilter ? this.repoFilter.has(r.path) : true,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Snipcode Git：顯示哪些 repo',
      placeHolder: '勾選要顯示的 repo（全選＝顯示全部）',
    });
    if (picked === undefined) return; // cancelled — keep current filter
    // All (or nothing) selected → no filter; otherwise restrict to the picks.
    this.repoFilter = picked.length === 0 || picked.length === all.length
      ? null
      : new Set(picked.map(p => p.repoPath));
    if (this.view) {
      this.view.message = this.repoFilter
        ? `已篩選 ${this.repoFilter.size} / ${all.length} 個 repo`
        : undefined;
    }
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
    reg('snipcode.git.stage', (n, ns) => this.stage(sel<FileNode>(n, ns)));
    reg('snipcode.git.unstage', (n, ns) => this.unstage(sel<FileNode>(n, ns)));
    reg('snipcode.git.stageRepo', (n) => this.stageRepo(n as RepoNode));
    reg('snipcode.git.unstageRepo', (n) => this.unstageRepo(n as RepoNode));
    reg('snipcode.git.stageAll', () => this.stageAll());
    reg('snipcode.git.unstageAll', () => this.unstageAll());
    reg('snipcode.git.refresh', () => this.refresh());
    reg('snipcode.git.openChange', (n) => this.openChange(n as FileNode));
    reg('snipcode.git.showDiff', (n) => this.showInDiffView(n as FileNode));
    reg('snipcode.git.copyAsClipCode', (n, ns) => this.copyAsClipCode(sel<ChangeTreeNode>(n, ns)));
    reg('snipcode.git.filterRepos', () => this.filterRepos());
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.svcs.clear();
  }
}
