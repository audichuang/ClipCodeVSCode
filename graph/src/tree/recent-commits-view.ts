import * as vscode from 'vscode';
import * as path from 'path';
import { MainPanel } from '../panels/MainPanel';
import { GitService } from '../git/git-service';
import { buildFullGraph, type FullGraphData } from '../git/git-graph-builder';
import type { BranchInfo, Commit } from '../git/types';
import { RepoDiscoveryService, type RepoInfo } from '../services/repo-discovery';
import { SequenceGuard } from '../utils/sequence-guard';

/* SNIPCODE-HOOK start: compact sidebar commit graph */
export interface RecentCommitsState {
  repoPath: string;
  repoName: string;
  repos: Array<{ path: string; name: string }>;
  commits: Commit[];
  branches: BranchInfo[];
  graph: FullGraphData;
  ahead: number;
  behind: number;
  tracking: boolean;
  staged: number;
  unstaged: number;
  conflicts: number;
  scope?: string;
  branch?: string;
  locale: string;
  loading?: boolean;
  error?: string;
}

export interface RecentRepoContext {
  get(): { path: string; service: GitService };
  switchToRepo(repoPath: string): void;
  openFullGraph(): void;
}

/** Read-only, compact commit graph for the Snipcode Git sidebar. */
export class RecentCommitsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'snipcode.recentCommits';
  private view: vscode.WebviewView | undefined;
  private readonly sequence = new SequenceGuard();
  private disposed = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: RecentRepoContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assetRoot = MainPanel.assetRootUri ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    view.webview.html = this.getHtml(view.webview, assetRoot);
    view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'recentCommitsReady') { await this.refresh(); return; }
      if (msg?.type === 'recentCommitsRefresh') { await this.refresh(); return; }
      if (msg?.type === 'recentCommitsOpenGraph') { this.context.openFullGraph(); return; }
      if (msg?.type === 'recentCommitsSelectRepo') {
        const repoPath = typeof msg.payload?.repoPath === 'string' ? msg.payload.repoPath : '';
        const repos = await this.discover();
        if (repos.some(repo => samePath(repo.path, repoPath))) {
          this.context.switchToRepo(repoPath);
          await this.refresh();
        }
      }
    });
  }

  /**
   * Repository switch + refresh moved out of the webview body and onto the view
   * title bar (package.json `view/title`, `view == snipcode.recentCommits`).
   * Native's Source Control Graph puts its repository picker in the pane header
   * too, and in a ~300px sidebar the old in-body `<select>` row cost a whole
   * row of height that the commit list needs more.
   */
  async pickRepo(): Promise<void> {
    const repos = await this.discover();
    if (repos.length === 0) { return; }
    const active = this.context.get().path;
    const picked = await vscode.window.showQuickPick(
      repos.map(repo => ({
        label: repo.name,
        description: samePath(repo.path, active) ? vscode.l10n.t('recentCurrentRepo') : undefined,
        detail: repo.path,
        repoPath: repo.path,
      })),
      { title: vscode.l10n.t('recentSwitchRepo'), matchOnDetail: true },
    );
    if (!picked || samePath(picked.repoPath, active)) { return; }
    this.context.switchToRepo(picked.repoPath);
    await this.refresh();
  }

  scheduleRefresh(): void {
    if (!this.view?.visible) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 180);
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.view?.visible) return;
    const ticket = this.sequence.issue();
    const { path: repoPath, service } = this.context.get();
    const localeSetting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = localeSetting === 'auto' ? (vscode.env.language || 'en') : localeSetting;
    const repos = await this.discover();
    try {
      const [rawCommits, branches, status] = await Promise.all([
        // HEAD keeps the compact view focused on the currently checked-out line
        // even when unrelated branches have newer commits.
        service.log({ branches: ['HEAD'], limit: 30 }),
        service.branches(),
        service.getUncommittedDiff(),
      ]);
      const commits = rawCommits
        .filter(commit => commit.hash !== 'UNCOMMITTED' && !commit.refs.some(ref => ref.type === 'stash'))
        .slice(0, 30);
      if (!this.sequence.isCurrent(ticket) || !this.view?.visible || !samePath(this.context.get().path, repoPath)) return;
      const current = branches.find(branch => branch.current);
      const state: RecentCommitsState = {
        repoPath,
        repoName: repos.find(repo => samePath(repo.path, repoPath))?.name ?? path.basename(repoPath),
        repos: repos.map(repo => ({ path: repo.path, name: repo.name })),
        commits,
        branches,
        graph: buildFullGraph(commits, branches),
        scope: 'HEAD',
        ahead: current?.ahead ?? 0,
        behind: current?.behind ?? 0,
        tracking: Boolean(current?.upstream && !current.upstreamGone),
        branch: current?.name,
        staged: status.staged.length,
        unstaged: status.unstaged.length,
        conflicts: status.conflict.length,
        locale,
      };
      void this.view.webview.postMessage({ type: 'recentCommitsState', payload: state });
    } catch (err) {
      if (!this.sequence.isCurrent(ticket) || !this.view?.visible || !samePath(this.context.get().path, repoPath)) return;
      const message = err instanceof Error ? err.message : String(err);
      const emptyRepo = /does not have any commits|unknown revision|ambiguous argument/i.test(message);
      void this.view.webview.postMessage({
        type: 'recentCommitsState',
        payload: {
          repoPath,
          repoName: path.basename(repoPath),
          repos: repos.map(repo => ({ path: repo.path, name: repo.name })),
          commits: [],
          branches: [],
          graph: { paths: [], links: [], dots: [], commitLeftMargin: [] },
          ahead: 0, behind: 0, tracking: false, staged: 0, unstaged: 0, conflicts: 0,
          locale, error: emptyRepo ? undefined : message,
        } satisfies RecentCommitsState,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.view = undefined;
  }

  private async discover(): Promise<RepoInfo[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    return RepoDiscoveryService.discoverRepos(folders).catch(() => []);
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
      <link href="${styleUri}" rel="stylesheet" /><link href="${codiconUri}" rel="stylesheet" /></head>
      <body data-view="recent-commits"><div id="workbench-app"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
  }
}

function samePath(a: string, b: string): boolean { return path.resolve(a) === path.resolve(b); }

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
/* SNIPCODE-HOOK end */
