import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/git-service';
import { RepoDiscoveryService } from '../services/repo-discovery';
import { runExclusive } from '../services/mutation-coordinator';
import { ChangesTreeProvider } from './changes-tree';
import type { RepoStatus, FileNode } from './build-change-tree';

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

  constructor() {
    this.tree = new ChangesTreeProvider(() => this.loadStatus());
  }

  private svcFor(repoPath: string): GitService {
    let svc = this.svcs.get(repoPath);
    if (!svc) { svc = new GitService(repoPath); this.svcs.set(repoPath, svc); }
    return svc;
  }

  /** Discover repos and read each one's staged/unstaged status + branch. */
  private async loadStatus(): Promise<RepoStatus[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const found = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
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

  private async stage(node: FileNode): Promise<void> {
    await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).stagePaths([node.path]));
    await this.refresh();
  }
  private async unstage(node: FileNode): Promise<void> {
    await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).unstagePaths([node.path]));
    await this.refresh();
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
    const status = (await this.loadStatus()).filter(r => r.staged.length > 0);
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

  registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...a: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('snipcode.git.stage', (n) => this.stage(n as FileNode));
    reg('snipcode.git.unstage', (n) => this.unstage(n as FileNode));
    reg('snipcode.git.stageAll', () => this.stageAll());
    reg('snipcode.git.unstageAll', () => this.unstageAll());
    reg('snipcode.git.refresh', () => this.refresh());
    reg('snipcode.git.openChange', (n) => this.openChange(n as FileNode));
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.svcs.clear();
  }
}
