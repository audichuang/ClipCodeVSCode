import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/git-service';
import { RepoDiscoveryService } from '../services/repo-discovery';
import { runExclusive } from '../services/mutation-coordinator';

/**
 * A resource state that remembers which repo + repo-relative path it maps to,
 * so command handlers (Task 3) can call the repo-relative git-service methods.
 */
export interface ScmResource extends vscode.SourceControlResourceState {
  repoPath: string;
  relPath: string;
  staged: boolean;
}

interface RepoScm {
  baseName: string;
  svc: GitService;
  sc: vscode.SourceControl;
  stagedGroup: vscode.SourceControlResourceGroup;
  changesGroup: vscode.SourceControlResourceGroup;
  branch: string;
}

/**
 * Owns one native VS Code SourceControl per discovered repo (all sharing the id
 * `snipcodeGit`, mirroring the built-in git provider's single id across repos).
 * Each repo gets a Staged Changes + Changes group populated from
 * getUncommittedDiff(). resourceUri points at the real file so VS Code supplies
 * the native file-type icon and the built-in git FileDecorationProvider colours
 * the filename / adds the status badge for free.
 */
export class SnipcodeScmManager implements vscode.Disposable {
  protected repos = new Map<string, RepoScm>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Discover repos, create a SourceControl each, then populate. */
  async init(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const found = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    for (const r of found) this.ensureRepo(r.path);
    await this.refresh();
  }

  private ensureRepo(repoPath: string): RepoScm {
    const existing = this.repos.get(repoPath);
    if (existing) return existing;
    const repo = this.createRepo(repoPath, path.basename(repoPath), '');
    this.repos.set(repoPath, repo);
    return repo;
  }

  /** Create a SourceControl + two groups. label carries the branch when known. */
  private createRepo(repoPath: string, baseName: string, branch: string): RepoScm {
    const label = branch ? `Snipcode Git · ${baseName} (${branch})` : `Snipcode Git · ${baseName}`;
    const sc = vscode.scm.createSourceControl('snipcodeGit', label, vscode.Uri.file(repoPath));
    const stagedGroup = sc.createResourceGroup('staged', 'Staged Changes');
    const changesGroup = sc.createResourceGroup('changes', 'Changes');
    stagedGroup.hideWhenEmpty = true;
    changesGroup.hideWhenEmpty = true;
    sc.inputBox.placeholder = 'Snipcode Git 提交訊息';
    // acceptInputCommand fires on the input box's commit (Enter/checkmark); the
    // handler is registered in Task 3. Passing repoPath lets it find this repo.
    sc.acceptInputCommand = { command: 'snipcode.scm.commit', title: 'Commit', arguments: [repoPath] };
    return { baseName, svc: new GitService(repoPath), sc, stagedGroup, changesGroup, branch };
  }

  /** Re-read status for every repo and repaint the groups. */
  async refresh(): Promise<void> {
    await Promise.all([...this.repos.keys()].map(p => this.refreshRepo(p)));
  }

  private async refreshRepo(repoPath: string): Promise<void> {
    let repo = this.repos.get(repoPath);
    if (!repo) return;
    const [diff, branches] = await Promise.all([
      repo.svc.getUncommittedDiff().catch(() => ({ staged: [], unstaged: [] })),
      repo.svc.branches().catch(() => []),
    ]);
    const current = branches.find(b => b.current);
    const branch = current?.detached ? 'HEAD detached' : (current?.name ?? '(no branch)');
    // SourceControl.label is readonly, so a branch change means recreate.
    if (branch !== repo.branch) {
      repo.sc.dispose();
      repo = this.createRepo(repoPath, repo.baseName, branch);
      this.repos.set(repoPath, repo);
    }
    repo.stagedGroup.resourceStates = diff.staged.map(e => this.toResource(repoPath, e, true));
    repo.changesGroup.resourceStates = diff.unstaged.map(e => this.toResource(repoPath, e, false));
    repo.sc.count = diff.staged.length + diff.unstaged.length;
  }

  private toResource(
    repoPath: string,
    entry: { path: string; status: string },
    staged: boolean,
  ): ScmResource {
    const resourceUri = vscode.Uri.file(path.join(repoPath, entry.path));
    const isDelete = entry.status === 'D';
    const isUntracked = entry.status === 'U' || entry.status === 'N';
    return {
      repoPath,
      relPath: entry.path,
      staged,
      resourceUri,
      // v1 opens the built-in git working-tree diff; a custom diff view is B-2b.
      command: { command: 'git.openChange', title: 'Open Changes', arguments: [resourceUri] },
      // NO iconPath: leaving it unset keeps the native file-type icon AND lets the
      // built-in git FileDecorationProvider colour the filename + add the status
      // badge on this URI. strikeThrough/tooltip are the only extras we add.
      decorations: {
        strikeThrough: isDelete,
        faded: isUntracked && !staged,
        tooltip: statusTooltip(entry.status),
      },
      contextValue: staged ? 'staged' : 'changes',
    };
  }

  /** Debounced re-status; wired to the FileWatcher in extension.ts. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('snipcode.scm.stage', (...args) => this.stage(flattenResources(args)));
    reg('snipcode.scm.unstage', (...args) => this.unstage(flattenResources(args)));
    reg('snipcode.scm.stageAll', (arg) => this.stageAll(arg as vscode.SourceControl));
    reg('snipcode.scm.unstageAll', (arg) => this.unstageAll(arg as vscode.SourceControl));
    reg('snipcode.scm.commit', (arg) => this.commit(arg));
    reg('snipcode.scm.refresh', () => this.refresh());
  }

  private async stage(resources: ScmResource[]): Promise<void> {
    await this.runByRepo(resources, (repo, relPaths) => repo.svc.stagePaths(relPaths));
    await this.refresh();
  }

  private async unstage(resources: ScmResource[]): Promise<void> {
    await this.runByRepo(resources, (repo, relPaths) => repo.svc.unstagePaths(relPaths));
    await this.refresh();
  }

  private async stageAll(sc: vscode.SourceControl): Promise<void> {
    const found = this.findByControl(sc);
    if (!found) return;
    const [repoPath, repo] = found;
    const relPaths = (repo.changesGroup.resourceStates as ScmResource[]).map(r => r.relPath);
    if (relPaths.length) await runExclusive(repoPath, () => repo.svc.stagePaths(relPaths));
    await this.refresh();
  }

  private async unstageAll(sc: vscode.SourceControl): Promise<void> {
    const found = this.findByControl(sc);
    if (!found) return;
    const [repoPath, repo] = found;
    const relPaths = (repo.stagedGroup.resourceStates as ScmResource[]).map(r => r.relPath);
    if (relPaths.length) await runExclusive(repoPath, () => repo.svc.unstagePaths(relPaths));
    await this.refresh();
  }

  /**
   * acceptInputCommand passes a repoPath string; a scm/title commit button would
   * pass the SourceControl. Accept both.
   */
  private async commit(arg: unknown): Promise<void> {
    let repoPath: string | undefined;
    if (typeof arg === 'string') {
      repoPath = arg;
    } else {
      repoPath = this.findByControl(arg as vscode.SourceControl)?.[0];
    }
    if (!repoPath) return;
    const repo = this.repos.get(repoPath);
    if (!repo) return;
    const message = repo.sc.inputBox.value.trim();
    if (!message) {
      void vscode.window.showWarningMessage('請先輸入提交訊息');
      return;
    }
    if (repo.stagedGroup.resourceStates.length === 0) {
      void vscode.window.showWarningMessage('沒有已暫存的變更可提交');
      return;
    }
    try {
      await runExclusive(repoPath, () => repo.svc.commitIndex(message));
      repo.sc.inputBox.value = '';
    } catch (err) {
      void vscode.window.showErrorMessage(`提交失敗：${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh();
  }

  /** Group resources by repo and run fn per repo under that repo's lock. */
  private async runByRepo(
    resources: ScmResource[],
    fn: (repo: RepoScm, relPaths: string[]) => Promise<void>,
  ): Promise<void> {
    const byRepo = new Map<string, string[]>();
    for (const r of resources) {
      const list = byRepo.get(r.repoPath) ?? [];
      list.push(r.relPath);
      byRepo.set(r.repoPath, list);
    }
    for (const [repoPath, relPaths] of byRepo) {
      const repo = this.repos.get(repoPath);
      if (!repo) continue;
      await runExclusive(repoPath, () => fn(repo, relPaths));
    }
  }

  private findByControl(sc: vscode.SourceControl): [string, RepoScm] | undefined {
    for (const [repoPath, repo] of this.repos) {
      if (repo.sc === sc) return [repoPath, repo];
    }
    return undefined;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const repo of this.repos.values()) repo.sc.dispose();
    this.repos.clear();
  }
}

function statusTooltip(status: string): string {
  switch (status) {
    case 'M': return 'Modified';
    case 'A': return 'Added';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'C': return 'Copied';
    case 'U': return 'Untracked';
    case 'N': return 'Nested repository';
    default: return status;
  }
}

/**
 * SCM resource-state commands receive the selected resources as varargs; a
 * multi-selection may arrive as a trailing array. Flatten to ScmResource[].
 */
function flattenResources(args: unknown[]): ScmResource[] {
  const out: ScmResource[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const x of a) if (isScmResource(x)) out.push(x);
    } else if (isScmResource(a)) {
      out.push(a);
    }
  }
  return out;
}

function isScmResource(x: unknown): x is ScmResource {
  return !!x && typeof x === 'object' && 'repoPath' in x && 'relPath' in x;
}
