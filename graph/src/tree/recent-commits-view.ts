import * as vscode from 'vscode';
import * as path from 'path';
import { MainPanel } from '../panels/MainPanel';
import { GitService } from '../git/git-service';
import { buildFullGraph, type FullGraphData } from '../git/git-graph-builder';
import type { BranchInfo, Commit } from '../git/types';
import { RepoDiscoveryService, type RepoInfo } from '../services/repo-discovery';
// Not a local `path.resolve` comparison: that normalizes separators but NOT the
// drive-letter case, so on Windows the repo guards here silently disagreed with
// RepoDiscoveryService — dropping every commit request and, before that, every
// refresh for the active repo. See utils/path.ts and issue #30.
import { samePath } from '../utils/path';
import { SequenceGuard } from '../utils/sequence-guard';
/* SNIPCODE-HOOK start: sidebar commit details — file list + native diff */
import { resolveRepoRelativePath } from '../utils/path-validation';
import { toGitUri } from '../utils/git-uri';
/* SNIPCODE-HOOK end */

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

/** One entry of `git diff --name-status` for the selected commit. */
export interface RecentCommitFile {
  path: string;
  status: string;
  oldPath?: string;
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
  private readonly filesSequence = new SequenceGuard();
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
      if (msg?.type === 'recentCommitsSelectCommit') { await this.sendCommitFiles(msg.payload); return; }
      if (msg?.type === 'recentCommitsOpenFile') { await this.openFile(msg.payload); return; }
      if (msg?.type === 'recentCommitsOpenChanges') { await this.openChanges(msg.payload); return; }
      if (msg?.type === 'recentCommitsCopy') { await this.copyText(msg.payload); return; }
      if (msg?.type === 'recentCommitsCopyFullSource') { await this.copyFullSource(msg.payload); return; }
      if (msg?.type === 'recentCommitsOpenWorkingFile') { await this.openWorkingFile(msg.payload); return; }
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

  /**
   * File list for the commit the user clicked. Its own SequenceGuard: a click
   * on another commit must win over an in-flight list, but it must not cancel
   * (or be cancelled by) the periodic `refresh()` of the graph itself.
   */
  private async sendCommitFiles(payload: unknown): Promise<void> {
    const message = payload as { hash?: unknown; repoPath?: unknown } | undefined;
    const hash = commitHash(message?.hash);
    if (!hash || !this.view?.visible) return;
    const { path: repoPath, service } = this.context.get();
    if (!isForRepo(message?.repoPath, repoPath)) return;
    const ticket = this.filesSequence.issue();
    try {
      const files = await service.showCommitFiles(hash);
      if (!this.filesSequence.isCurrent(ticket) || !this.view?.visible) return;
      if (!samePath(this.context.get().path, repoPath)) return;
      void this.view.webview.postMessage({ type: 'recentCommitsCommitFiles', payload: { hash, files } });
    } catch (err) {
      if (!this.filesSequence.isCurrent(ticket) || !this.view?.visible) return;
      if (!samePath(this.context.get().path, repoPath)) return;
      void this.view.webview.postMessage({
        type: 'recentCommitsCommitFiles',
        payload: { hash, files: [], error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * One file of one commit, in the native diff editor — parent revision on the
   * left, the commit on the right, both through the built-in git content
   * provider (see utils/git-uri). Same comparison MainPanel opens for a graph
   * row, so a file looks identical whichever surface opened it.
   */
  private async openFile(payload: unknown): Promise<void> {
    const message = payload as { hash?: unknown; path?: unknown; oldPath?: unknown; repoPath?: unknown } | undefined;
    const hash = commitHash(message?.hash);
    if (!hash) return;
    const { path: repoPath, service } = this.context.get();
    // The webview names the repo its row came from: the active repo can already
    // have changed (extension.ts switches the context synchronously, the new
    // state only arrives after its git queries finish), and two repos sharing a
    // commit would otherwise silently open the OTHER repo's file.
    if (!isForRepo(message?.repoPath, repoPath)) return;
    try {
      // Webview-supplied paths are untrusted: reject traversal before they
      // reach a URI or the git CLI.
      const relPath = typeof message?.path === 'string' ? message.path : '';
      const fullPath = resolveRepoRelativePath(repoPath, relPath, 'recentOpenFile');
      const oldPath = typeof message?.oldPath === 'string' ? message.oldPath : undefined;
      const { fallbackRef, perFile } = await service.resolveCommitFileBases(hash);
      // A merge's file may have come in from parent 2..N (first parent → empty
      // diff), and the parent that carries it may not know the rename, so the
      // left side takes BOTH its ref and its path from the same resolution.
      const base = perFile.get(relPath) ?? { ref: fallbackRef, path: oldPath ?? relPath };
      const leftPath = resolveRepoRelativePath(repoPath, base.path, 'recentOpenFile');
      await vscode.commands.executeCommand(
        'vscode.diff',
        toGitUri(leftPath, base.ref),
        toGitUri(fullPath, hash),
        `${path.basename(fullPath)} (${hash.substring(0, 7)})`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Every file of the commit in one multi-diff editor — the same gesture
   * native's Source Control Graph offers as "Open Changes".
   */
  private async openChanges(payload: unknown): Promise<void> {
    const message = payload as { hash?: unknown; subject?: unknown; repoPath?: unknown } | undefined;
    const hash = commitHash(message?.hash);
    if (!hash) return;
    const { path: repoPath, service } = this.context.get();
    if (!isForRepo(message?.repoPath, repoPath)) return;
    try {
      const [files, bases] = await Promise.all([
        service.showCommitFiles(hash),
        service.resolveCommitFileBases(hash),
      ]);
      if (files.length === 0) return;
      // `vscode.changes(title, [resource, original, modified][])` — `resource`
      // drives the row label and Go To File; the other two are the diff sides.
      const resources = files.map(file => {
        const fullPath = resolveRepoRelativePath(repoPath, file.path, 'recentOpenChanges');
        const base = bases.perFile.get(file.path)
          ?? { ref: bases.fallbackRef, path: file.oldPath ?? file.path };
        const leftPath = resolveRepoRelativePath(repoPath, base.path, 'recentOpenChanges');
        return [vscode.Uri.file(fullPath), toGitUri(leftPath, base.ref), toGitUri(fullPath, hash)];
      });
      // Native titles this editor with the commit's subject; a bare hash would
      // put the user right back to "which commit is this?".
      const short = hash.substring(0, 7);
      const subject = typeof message?.subject === 'string'
        ? message.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
        : '';
      await vscode.commands.executeCommand('vscode.changes', subject ? `${subject} (${short})` : short, resources);
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  /** Clipboard only. Still repo-guarded: a row the view has not repainted yet
   *  must not put another repository's hash on the clipboard. */
  private async copyText(payload: unknown): Promise<void> {
    const message = payload as { text?: unknown; repoPath?: unknown } | undefined;
    if (typeof message?.text !== 'string' || message.text.length === 0) return;
    if (!isForRepo(message?.repoPath, this.context.get().path)) return;
    await vscode.env.clipboard.writeText(message.text);
  }

  /**
   * Snipcode's own Copy Full Source, for one file or the whole commit. Pure
   * transfer to the handler the host already injected (logic in
   * `src/graphCopy.ts`); the file list and the repo root are resolved HERE so
   * the webview never has to know the GraphCopyPayload shape.
   */
  private async copyFullSource(payload: unknown): Promise<void> {
    const message = payload as { hash?: unknown; path?: unknown; repoPath?: unknown } | undefined;
    const hash = commitHash(message?.hash);
    if (!hash) return;
    const { path: repoPath, service } = this.context.get();
    if (!isForRepo(message?.repoPath, repoPath)) return;
    try {
      const only = typeof message?.path === 'string' ? message.path : undefined;
      // Validated even though it is only ever compared, never opened: an
      // unchecked value here would decide which blobs get read.
      if (only) resolveRepoRelativePath(repoPath, only, 'recentCopyFullSource');
      const files = (await service.showCommitFiles(hash))
        .filter(file => !only || file.path === only)
        .map(file => ({
          repoRootFsPath: repoPath,
          relativePath: file.path,
          oldRelativePath: file.oldPath,
          status: file.status,
        }));
      if (files.length === 0) return;
      await MainPanel.copyFullSourceAtCommit?.({ hash, files }, MainPanel.copyRuntime);
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  /** The working-tree file itself, not a diff — native's only inline action on
   *  a commit's file row, and the last step of "read the diff, go edit it". */
  private async openWorkingFile(payload: unknown): Promise<void> {
    const message = payload as { path?: unknown; repoPath?: unknown } | undefined;
    const { path: repoPath } = this.context.get();
    if (!isForRepo(message?.repoPath, repoPath)) return;
    try {
      const fullPath = resolveRepoRelativePath(repoPath, message?.path, 'recentOpenWorkingFile');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
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

/** Object names only. GitService asserts refs too, but the hash also ends up in
 *  a URI and an editor title, so it is validated at the message boundary.
 *  Up to 64 hex, not 40: a SHA-256 repository's `%H` is 64 characters, and
 *  capping at 40 silently dropped every request there (panel stuck on
 *  "Loading", diffs no-op) even though GitService handles SHA-256 empty trees. */
function commitHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{4,64}$/i.test(value) ? value : undefined;
}

/** A commit-scoped request is honoured only for the repo the webview named.
 *  A message with no `repoPath` is dropped rather than guessed at — losing a
 *  click is recoverable, opening another repository's file is not. */
function isForRepo(claimed: unknown, active: string): boolean {
  return typeof claimed === 'string' && claimed.length > 0 && samePath(claimed, active);
}


function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
/* SNIPCODE-HOOK end */
