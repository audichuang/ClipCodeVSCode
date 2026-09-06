import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/git-service';
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
      () => this.loadStatus(),
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

  /** Discover repos (respecting the filter) and read each one's status + branch. */
  /* SNIPCODE-HOOK start: Batch D commit status-read guard */
  private async loadStatus(strict = false, uncheckedSnapshot: ReadonlySet<string> = this.uncheckedForCommit): Promise<RepoStatus[]> {
    const found = await this.discover();
    const out: RepoStatus[] = [];
    for (const r of found) {
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
          return { staged: [], unstaged: [], conflict: [] };
        }),
        svc.branches().catch(() => []),
        svc.aheadBehind(), // never throws; null when no upstream
      ]);
      const current = branches.find(b => b.current);
      const branch = current?.detached ? 'HEAD (detached)' : (current?.name ?? '(no branch)');
      out.push({
        repoName: r.name, repoPath: r.path, branch,
        ahead: aheadBehind?.ahead, behind: aheadBehind?.behind,
        staged: diff.staged, unstaged: diff.unstaged,
        /* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
        conflict: diff.conflict ?? [],
        /* SNIPCODE-HOOK end */
      });
    }
    return out;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
  async refresh(): Promise<void> {
    await this.tree.refresh();
    this.diffPanel?.invalidateIndexDocuments();
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
      void vscode.window.showInformationMessage('No git repositories in workspace');
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
              skipped.push(`${name}: 無 remote，已略過`);
            }
          } catch (err) {
            failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    );
    await this.refresh();
    const ok = repos.length - failures.length - skipped.length;
    if (failures.length > 0) {
      void vscode.window.showErrorMessage(`${verb}：${ok}/${repos.length} 成功；${[...failures, ...skipped].join('；')}`);
    } else if (skipped.length > 0) {
      void vscode.window.showWarningMessage(`${verb}：${ok}/${repos.length} 成功；${skipped.join('；')}`);
    } else {
      vscode.window.setStatusBarMessage(`${verb} ✓ (${repos.length} repos)`, 5000);
    }
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
    /* SNIPCODE-HOOK start: Batch B retain rename source path */
    if (node.files.length) await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).unstagePaths(node.files));
    /* SNIPCODE-HOOK end */
    await this.refresh();
  }

  /* SNIPCODE-HOOK start: S4 Discard working-tree changes (file + repo layers) */
  /** Revert the working-tree edits for the selected unstaged file(s) — tracked
   *  paths restore from HEAD, untracked paths are deleted. Destructive and
   *  unrecoverable, so it always confirms via a modal warning first. */
  private async discard(nodes: FileNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const label = nodes.length === 1 ? nodes[0].path : `${nodes.length} 個檔案`;
    const confirmed = await vscode.window.showWarningMessage(
      `捨棄 ${label} 的變更？此動作無法復原。`,
      { modal: true },
      '捨棄',
    );
    if (confirmed !== '捨棄') return;
    await this.byRepo(nodes, (svc, changes) => svc.discardPaths(changes));
  }

  /** Discard every unstaged file of one repo (the repo node under Unstaged). */
  private async discardRepo(node: RepoNode): Promise<void> {
    const files = node.files.filter(f => f.status !== 'N');
    if (files.length === 0) return;
    const confirmed = await vscode.window.showWarningMessage(
      `捨棄 ${node.repoName} 中 ${files.length} 個檔案的變更？此動作無法復原。`,
      { modal: true },
      '捨棄',
    );
    if (confirmed !== '捨棄') return;
    await runExclusive(node.repoPath, () => this.svcFor(node.repoPath).discardPaths(files));
    await this.refresh();
  }
  /* SNIPCODE-HOOK end */

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
      this.view.message = `已略過含未解決衝突的 repo：${blocked.map(r => r.repoName).join('、')}`;
    }
    /* SNIPCODE-HOOK end */
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

  /* SNIPCODE-HOOK start: S9 inline "Open in Editor" opens the plain file, not a diff */
  /** The inline go-to-file icon: open the file itself, not VS Code's own diff
   *  view (that was a silent second diff UI alongside the Snipcode Diff tab —
   *  see S9 in the sidebar audit). The native diff is still reachable via the
   *  "Open Changes (VS Code)" context-menu entry, openChangeNative below. */
  private async openChange(node: FileNode): Promise<void> {
    const uri = vscode.Uri.file(path.join(node.repoPath, node.path));
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  /** Right-click-only: VS Code's built-in diff view for this change. */
  private async openChangeNative(node: FileNode): Promise<void> {
    const uri = vscode.Uri.file(path.join(node.repoPath, node.path));
    await vscode.commands.executeCommand('git.openChange', uri);
  }
  /* SNIPCODE-HOOK end */

  /** Read a file's parsed DiffData (staged or unstaged side) for the Diff panel.
   *  Reuses getUncommittedFileDiff so the hunk order aligns with the raw
   *  stageHunks/unstageHunks re-fetch (same git diff command per side).
   *  Throws on git failure — null strictly means "this side has no diff",
   *  so the panel can tell an error apart from an empty state. */
  async fileDiffData(repoPath: string, file: string, side: ChangeGroup): Promise<DiffData | null> {
    return this.svcFor(repoPath).getUncommittedFileDiff(file, side === 'staged');
  }

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
  private showInDiffView(node: FileNode): void {
    this.diffPanel?.show(node.repoPath, node.path);
  }

  /** Stage the selected hunks of one unstaged file, then refresh the tree and
   *  re-render the file's (now smaller) unstaged diff in the panel. */
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  async stageHunks(repoPath: string, file: string, hunkIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageHunks(file, hunkIndices, fingerprint));
    await this.refresh();
    // Only re-render if the user is still on this file — a slow apply must not
    // yank the panel back after they navigated elsewhere.
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
  }

  /** Unstage the selected hunks of one staged file, then refresh + re-render the
   *  file's remaining staged diff. */
  async unstageHunks(repoPath: string, file: string, hunkIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageHunks(file, hunkIndices, fingerprint));
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
  }

  /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage, mirrors stageHunks. */
  /** Stage the selected changed lines of one hunk of an unstaged file. */
  async stageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageLines(file, hunkIndex, lineIndices, fingerprint));
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
  }

  /** Unstage the selected changed lines of one hunk of a staged file. */
  async unstageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[], fingerprint: string, operationId?: string): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageLines(file, hunkIndex, lineIndices, fingerprint));
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file, operationId);
  }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

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
      /* SNIPCODE-HOOK start: Batch D retain disambiguated repo names */
      label: r.name,
      /* SNIPCODE-HOOK end */
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
    /* SNIPCODE-HOOK start: Batch B constrain mixed tree selections */
    const sameGroup = (n: unknown, ns: unknown): FileNode[] => {
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
        void vscode.window.showWarningMessage(
          `已略過 ${all.length - kept.length} 個屬於其他 repo 或另一側的選取項目`);
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
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.svcs.clear();
  }
}
