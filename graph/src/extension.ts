import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync } from 'fs';
import { setGitBinaryPath } from './git/git-binary';
import { MainPanel } from './panels/MainPanel';
import { GitService } from './git/git-service';
import { FileWatcher } from './services/file-watcher';
import { BranchesViewProvider } from './views/branches-view';
import { RemotesViewProvider } from './views/remotes-view';
import { TagsViewProvider } from './views/tags-view';
import { StashesViewProvider } from './views/stashes-view';
import { WorktreesViewProvider } from './views/worktrees-view';
import { StatusBarManager } from './views/status-bar';
import { RepoDiscoveryService } from './services/repo-discovery';
import { ChangesWorkbench } from './tree/changes-workbench';
import { CommitBoxViewProvider } from './tree/commit-box-view';
/* SNIPCODE-HOOK start: compact sidebar commit graph */
import { RecentCommitsViewProvider } from './tree/recent-commits-view';
/* SNIPCODE-HOOK end */
/* SNIPCODE-HOOK start: S5 own FileDecorationProvider */
import { ChangeDecorationProvider } from './tree/change-decorations';
/* SNIPCODE-HOOK end */
import { DiffPanel } from './panels/DiffPanel';
import { samePath } from './utils/path';
import { resolveDefaultWorktreePath } from './utils/worktree-path';
import { readTimeoutMs } from './utils/config';

/**
 * Resolve the `git.path` setting to an existing executable. The setting may be
 * a single path or an array of candidates (VS Code uses the first that exists).
 * Returns undefined when nothing is configured or none of the candidates exist.
 */
export function resolveConfiguredGitPath(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  const candidates = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/* SNIPCODE-HOOK start: host-facing activate adapter (S5)
   The vendored activate() is an extension entry point, not a library. Snipcode
   must NOT register it as a VSIX main (would double-register / leak on reload).
   Instead the host calls activateGraph(context, opts) AFTER its own activation:
     - opts.assetRootUri  → where the host shipped the webview bundle (§6.2);
       stored on MainPanel so the panel resolves assets + localResourceRoots
       from it instead of the vendored 'webview-ui/dist' layout.
     - opts.copyFullSourceAtCommit → host clipboard handler, stored on MainPanel
       and invoked by the S2 handleMessage case (logic in src/graphCopy.ts).
   All disposables flow into context.subscriptions via the original activate(),
   so reload / disable-enable tear down cleanly. */
export function activateGraph(
  context: vscode.ExtensionContext,
  opts: {
    assetRootUri: vscode.Uri;
    // Mirrors src/graphCopy.ts GraphCopyPayload (inline so vendored stays
    // host-import-free; Task 3 tightens the payload field types).
    copyFullSourceAtCommit: (
      payload: { hash: string; files: unknown[] },
      runtime?: { gitPath?: string; gitEnv?: Record<string, string> },
    ) => Promise<void>;
  },
): void {
  MainPanel.assetRootUri = opts.assetRootUri;
  MainPanel.copyFullSourceAtCommit = opts.copyFullSourceAtCommit;
  activate(context);
  context.subscriptions.push({
    dispose: () => {
      MainPanel.assetRootUri = undefined;
      MainPanel.copyFullSourceAtCommit = undefined;
    },
  });
}
/* SNIPCODE-HOOK end */

export function activate(context: vscode.ExtensionContext) {
  // Status bar is always visible regardless of workspace state
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Persistent avatar cache lives under globalStorage so every window reuses
  // the same avatars instead of re-fetching from gravatar.com (issue #38).
  MainPanel.setAvatarCacheDir(vscode.Uri.joinPath(context.globalStorageUri, 'avatars').fsPath);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    context.subscriptions.push(
      vscode.commands.registerCommand('git-graph-plus.open', () => {
        vscode.window.showWarningMessage('Git Graph+: No workspace folder open.');
      }),
      vscode.commands.registerCommand('gitGraphPlus.open', () => {
        vscode.window.showWarningMessage('Git Graph+: No workspace folder open.');
      }),
    );
    // VS Code does not re-run activate() when the user opens a folder later
    // (e.g. starts from an empty window and uses File → Open Folder). The
    // extension would silently stay in no-workspace mode forever. When a
    // folder appears, prompt to reload so a fresh activate runs against the
    // new workspace.
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        if (e.added.length === 0) return;
        const reload = await vscode.window.showInformationMessage(
          vscode.l10n.t('Git Graph+: Reload window to activate the extension for the newly opened folder?'),
          vscode.l10n.t('Reload'),
        );
        if (reload) {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }),
    );
    return;
  }

  let activeRepoPath = workspaceFolder.uri.fsPath;
  // Set once the ChangesWorkbench exists (below); the built-in git env callback
  // fires on a later microtask, so it forwards the env through this reference.
  let workbenchRef: ChangesWorkbench | undefined;

  // Resolve the git executable so the extension works when git is not on PATH
  // (e.g. portable/MSYS2 installs configured via `git.path`). The configured
  // path takes precedence; otherwise we fall back to the path the built-in git
  // extension resolved (set below once its API is available), then to PATH. #18
  let apiGitPath: string | undefined;
  const applyGitPath = () => setGitBinaryPath(resolveConfiguredGitPath() ?? apiGitPath);
  applyGitPath();

  let activeGitService = new GitService(activeRepoPath);
  activeGitService.setDefaultTimeout(readTimeoutMs());
  MainPanel.setGitServiceProvider((repoPath) => samePath(repoPath, activeRepoPath) ? activeGitService : undefined);
  context.subscriptions.push({
    dispose: () => MainPanel.setGitServiceProvider(null),
  });

  // Inject VS Code's built-in git extension askpass env so authentication prompts work
  const builtinGit = vscode.extensions.getExtension('vscode.git');
  if (builtinGit) {
    const waitForGit = builtinGit.isActive ? Promise.resolve(builtinGit.exports) : Promise.resolve(builtinGit.activate());
    waitForGit.then((ext: { getAPI(version: number): { git: { env?: Record<string, string>; path?: string } } }) => {
      try {
        const git = ext.getAPI(1)?.git;
        if (git?.env) {
          activeGitService.setExtraEnv(git.env);
          MainPanel.setExtraEnv(git.env);
          workbenchRef?.setGitEnv(git.env);
        }
        // The built-in extension's resolved path already honors `git.path`; adopt
        // it as the fallback for when the user hasn't set a valid `git.path`.
        if (typeof git?.path === 'string' && git.path) {
          apiGitPath = git.path;
          applyGitPath();
        }
      } catch { /* built-in git extension API unavailable */ }
    }).catch(() => {});
  }

  // Re-resolve when the user changes `git.path` at runtime.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('git.path')) applyGitPath();
      if (e.affectsConfiguration('gitGraphPlus.timeout')) activeGitService.setDefaultTimeout(readTimeoutMs());
    }),
  );

  // --- Tree View Providers ---
  const branchesProvider = new BranchesViewProvider(activeGitService);
  const remotesProvider = new RemotesViewProvider(activeGitService);
  const tagsProvider = new TagsViewProvider(activeGitService);
  const stashesProvider = new StashesViewProvider(activeGitService);
  const worktreesProvider = new WorktreesViewProvider(activeGitService);

  const branchesView = vscode.window.createTreeView('gitGraphPlus.branches', { treeDataProvider: branchesProvider });
  const remotesView = vscode.window.createTreeView('gitGraphPlus.remotes', { treeDataProvider: remotesProvider });
  const tagsView = vscode.window.createTreeView('gitGraphPlus.tags', { treeDataProvider: tagsProvider });
  const stashesView = vscode.window.createTreeView('gitGraphPlus.stashes', { treeDataProvider: stashesProvider });
  const worktreesView = vscode.window.createTreeView('gitGraphPlus.worktrees', { treeDataProvider: worktreesProvider });

  const initialRepoName = path.basename(activeRepoPath);
  branchesView.description = initialRepoName;
  remotesView.description = initialRepoName;
  tagsView.description = initialRepoName;
  stashesView.description = initialRepoName;
  worktreesView.description = initialRepoName;

  context.subscriptions.push(
    branchesProvider,
    remotesProvider,
    tagsProvider,
    stashesProvider,
    worktreesProvider,
    branchesView,
    remotesView,
    tagsView,
    stashesView,
    worktreesView,
  );

  // --- Snipcode Git commit workbench (TreeView + commit-box webview, B-2) ---
  // TreeView paints Staged/Unstaged → repo → file (native file icons via
  // resourceUri); the webview above it is the shared commit message box.
  const workbench = new ChangesWorkbench();
  workbenchRef = workbench;
  const changesView = vscode.window.createTreeView('snipcode.changes', { treeDataProvider: workbench.tree, showCollapseAll: true, canSelectMany: true });
  workbench.setView(changesView);
  changesView.onDidChangeCheckboxState((e) => workbench.handleCheckboxChange(e.items));
  /* SNIPCODE-HOOK start: Changes selection follows the selected repo even when
     no active editor exists (custom Diff opens from the tree command). */
  const changesSelection = changesView.onDidChangeSelection((e) => {
    const node = e.selection[0] as { kind?: string; repoPath?: string } | undefined;
    if (node?.repoPath) switchToRepo(node.repoPath);
  });
  /* SNIPCODE-HOOK end */
  const diffPanel = DiffPanel.register(context.extensionUri, workbench);
  workbench.setDiffPanel(diffPanel);
  /* SNIPCODE-HOOK start: compact sidebar commit graph */
  const recentCommits = new RecentCommitsViewProvider(context.extensionUri, {
    get: () => ({ path: activeRepoPath, service: activeGitService }),
    switchToRepo,
    openFullGraph: () => MainPanel.createOrShow(context.extensionUri, activeRepoPath),
  });
  /* SNIPCODE-HOOK start: recent-commits view title actions — repository switch,
     refresh and open-full-graph live in the pane header (package.json
     `view/title`) instead of a toolbar row inside the 300px webview. */
  context.subscriptions.push(
    vscode.commands.registerCommand('snipcode.git.recentPickRepo', () => recentCommits.pickRepo()),
    vscode.commands.registerCommand('snipcode.git.recentRefresh', () => recentCommits.refresh()),
    vscode.commands.registerCommand('snipcode.git.recentOpenGraph', () => MainPanel.createOrShow(context.extensionUri, activeRepoPath)),
  );
  /* SNIPCODE-HOOK end */

  const recentTreeRefresh = workbench.tree.onDidChangeTreeData(() => recentCommits.scheduleRefresh());
  /* SNIPCODE-HOOK end */
  context.subscriptions.push(
    workbench,
    changesView,
    changesSelection,
    diffPanel,
    recentCommits,
    recentTreeRefresh,
    /* SNIPCODE-HOOK start: S5 own FileDecorationProvider */
    vscode.window.registerFileDecorationProvider(new ChangeDecorationProvider()),
    /* SNIPCODE-HOOK end */
    vscode.window.registerWebviewViewProvider(
      CommitBoxViewProvider.viewType,
      new CommitBoxViewProvider(context.extensionUri, workbench),
      /* SNIPCODE-HOOK start: R6 keep the commit draft alive while the view is hidden
         Without this, switching Activity (e.g. to Explorer) or collapsing the
         view disposes the webview and any in-progress commit message is lost. */
      { webviewOptions: { retainContextWhenHidden: true } },
      /* SNIPCODE-HOOK end */
    ),
    vscode.window.registerWebviewViewProvider(
      RecentCommitsViewProvider.viewType,
      recentCommits,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  workbench.registerCommands(context);
  void workbench.refresh();
  // One FileWatcher per discovered repo, funnelled through the workbench's 300ms
  // debounce. Dynamic repo add/remove re-wiring is a follow-up.
  const scmFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  RepoDiscoveryService.discoverRepos(scmFolders).then(repos => {
    for (const r of repos) {
      const w = new FileWatcher(r.path, () => workbench.scheduleRefresh());
      w.enabled = true;
      context.subscriptions.push(w);
    }
  }).catch(() => {});

  // Prefetch all tree view data in parallel so first expand is instant
  Promise.all([
    branchesProvider.prefetch(),
    remotesProvider.prefetch(),
    tagsProvider.prefetch(),
    stashesProvider.prefetch(),
    worktreesProvider.prefetch(),
  ]).catch((err) => { console.warn('Git Graph+: sidebar prefetch failed:', err instanceof Error ? err.message : err); });

  // --- File Watcher ---
  // This watcher owns the sidebar; the graph panel runs its own FileWatcher
  // (with a smarter partial-refresh path). When the panel is open, calling
  // postRefresh() here just duplicated that panel watcher's graph refresh;
  // when it's closed there's no panel to refresh. So this only refreshes the
  // sidebar. (The sidebar refresh shares one debounce timer with the panel
  // watcher's onSidebarRefresh, so they coalesce rather than double up.)
  let fileWatcher = new FileWatcher(activeRepoPath, () => {
    // External change (terminal git, another window): the shared read cache
    // was populated before it happened — drop it before re-reading.
    activeGitService.clearReadCache();
    refreshAll();
  }, { watchWorkingTree: false });
  fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
  context.subscriptions.push({ dispose: () => fileWatcher.dispose() });

  // Working-tree saves are already caught by FileWatcher's '**' watcher (it
  // classifies them as 'status' and refreshes both the sidebar and the panel,
  // debounced and gated on the autoRefresh setting). A separate
  // onDidSaveTextDocument handler here only duplicated that work — firing an
  // immediate, un-debounced full refresh on every save in any workspace repo,
  // even when autoRefresh was off — so it was removed.

  // --- Auto-detect Git Repo if root isn't one ---
  RepoDiscoveryService.discoverRepos([activeRepoPath]).then(repos => {
    if (repos.length > 0 && !repos.some(r => samePath(r.path, activeRepoPath))) {
      const firstRepo = repos[0].path;
      activeRepoPath = firstRepo;
      activeGitService = new GitService(activeRepoPath);
      activeGitService.setDefaultTimeout(readTimeoutMs());

      // Re-inject environment if needed
      if (builtinGit && builtinGit.exports) {
        try {
          const env = (builtinGit.exports as any).getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
      
      // Update providers
      branchesProvider.setGitService(activeGitService);
      remotesProvider.setGitService(activeGitService);
      tagsProvider.setGitService(activeGitService);
      stashesProvider.setGitService(activeGitService);
      worktreesProvider.setGitService(activeGitService);

      // Update view descriptions
      const repoName = path.basename(activeRepoPath);
      branchesView.description = repoName;
      remotesView.description = repoName;
      tagsView.description = repoName;
      stashesView.description = repoName;
      worktreesView.description = repoName;

      // Update file watcher (sidebar-only; see the watcher above for why).
      fileWatcher.dispose();
      fileWatcher = new FileWatcher(activeRepoPath, () => {
        // External change (terminal git, another window): the shared read cache
        // was populated before it happened — drop it before re-reading.
        activeGitService.clearReadCache();
        refreshAll();
      }, { watchWorkingTree: false });
      fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
    }
  }).catch((err) => { console.warn('Git Graph+: repo discovery failed:', err instanceof Error ? err.message : err); });

  // When workspace folders change (multi-root add/remove), re-discover repos
  // so the repo dropdown in the panel reflects reality. The panel-side
  // discovery cache is invalidated by sendRepoList(true).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      RepoDiscoveryService.clearCache();
      MainPanel.currentPanel?.sendRepoList(true).catch(() => {});
      doSidebarRefresh();
    }),
  );

  let sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sidebarRefreshing = false;
  let sidebarRefreshQueued = false;
  context.subscriptions.push({
    dispose: () => {
      if (sidebarRefreshTimer) {
        clearTimeout(sidebarRefreshTimer);
        sidebarRefreshTimer = null;
      }
    },
  });
  async function doSidebarRefresh() {
    if (sidebarRefreshing) { sidebarRefreshQueued = true; return; }
    sidebarRefreshing = true;
    try {
      await Promise.all([
        branchesProvider.refresh(),
        remotesProvider.refresh(),
        tagsProvider.refresh(),
        stashesProvider.refresh(),
        worktreesProvider.refresh(),
      ]);

      // Reveal current branch in sidebar (auto-expands folders)
      // ONLY if the view is already visible to prevent jumping to the SCM tab
      const currentItem = branchesProvider.getCurrentItem();
      if (currentItem && branchesView.visible) {
        // Small delay to ensure the tree view has processed the data change
        setTimeout(() => {
          branchesView.reveal(currentItem, { select: false, focus: false, expand: true }).then(undefined, () => {});
        }, 100);
      }
    } finally {
      sidebarRefreshing = false;
      if (sidebarRefreshQueued) {
        sidebarRefreshQueued = false;
        // Re-run once more to pick up changes that arrived during refresh.
        doSidebarRefresh();
      }
    }
  }
  function refreshAll() {
    if (sidebarRefreshTimer) { clearTimeout(sidebarRefreshTimer); }
    sidebarRefreshTimer = setTimeout(() => {
      sidebarRefreshTimer = null;
      recentCommits.scheduleRefresh();
      doSidebarRefresh();
    }, 300);
  }

  function switchToRepo(newPath: string) {
    if (samePath(newPath, activeRepoPath)) { return; }
    activeRepoPath = newPath;
    activeGitService = new GitService(newPath);
    activeGitService.setDefaultTimeout(readTimeoutMs());

    if (builtinGit) {
      const ext = builtinGit.exports;
      if (ext) {
        try {
          const env = ext.getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
    }

    branchesProvider.setGitService(activeGitService);
    remotesProvider.setGitService(activeGitService);
    tagsProvider.setGitService(activeGitService);
    stashesProvider.setGitService(activeGitService);
    worktreesProvider.setGitService(activeGitService);

    const repoName = path.basename(newPath);
    branchesView.description = repoName;
    remotesView.description = repoName;
    tagsView.description = repoName;
    stashesView.description = repoName;
    worktreesView.description = repoName;

    fileWatcher.dispose();
    fileWatcher = new FileWatcher(newPath, () => {
      // External change (terminal git, another window): the shared read cache
      // was populated before it happened — drop it before re-reading.
      activeGitService.clearReadCache();
      refreshAll();
    }, { watchWorkingTree: false });
    fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);

    // If the webview panel is open, sync it to the new repo as well.
    // MainPanel.switchRepo() will call onRepoChange → switchToRepo again,
    // but the path.resolve guard above prevents an infinite loop.
    MainPanel.currentPanel?.switchRepo(newPath);

    refreshAll();
    recentCommits.scheduleRefresh();
  }

  let editorRepoSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  context.subscriptions.push({
    dispose: () => {
      if (editorRepoSwitchTimer) {
        clearTimeout(editorRepoSwitchTimer);
        editorRepoSwitchTimer = null;
      }
    },
  });
  function scheduleEditorRepoSwitch(newPath: string) {
    if (samePath(newPath, activeRepoPath)) return;
    if (editorRepoSwitchTimer) clearTimeout(editorRepoSwitchTimer);
    editorRepoSwitchTimer = setTimeout(() => {
      editorRepoSwitchTimer = null;
      switchToRepo(newPath);
    }, 150);
  }

  MainPanel.onSidebarRefresh = refreshAll;
  MainPanel.onRepoChange = switchToRepo;

  function getWorktreeUri(wtItem: { worktree?: { path?: string } } | undefined): vscode.Uri | undefined {
    const wtPath = wtItem?.worktree?.path;
    return wtPath ? vscode.Uri.file(wtPath) : undefined;
  }

  function openWorktree(wtItem: { worktree?: { path?: string } } | undefined): void {
    const uri = getWorktreeUri(wtItem);
    if (!uri) { return; }
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  }

  function openWorktreeInFileExplorer(wtItem: { worktree?: { path?: string } } | undefined): void {
    const uri = getWorktreeUri(wtItem);
    if (!uri) { return; }
    vscode.env.openExternal(uri);
  }

  // Auto-switch sidebar when the active editor moves to a different repo
  if (builtinGit) {
    const waitForGitApi = builtinGit.isActive
      ? Promise.resolve(builtinGit.exports)
      : Promise.resolve(builtinGit.activate());
    waitForGitApi.then((ext: {
      getAPI(version: number): {
        repositories: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }[];
        onDidOpenRepository: vscode.Event<{ rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }>;
        getRepository(uri: vscode.Uri): { rootUri: vscode.Uri } | null;
      }
    }) => {
      try {
        const gitApi = ext.getAPI(1);

        function watchRepo(repo: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }) {
          context.subscriptions.push(
            repo.ui.onDidChange(() => {
              if (repo.ui.selected) { switchToRepo(repo.rootUri.fsPath); }
            })
          );
        }

        for (const repo of gitApi.repositories) { watchRepo(repo); }
        context.subscriptions.push(gitApi.onDidOpenRepository(watchRepo));

        context.subscriptions.push(
          vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) { return; }
            const repo = gitApi.getRepository(editor.document.uri);
            if (repo?.rootUri) { scheduleEditorRepoSwitch(repo.rootUri.fsPath); }
          })
        );
      } catch { /* git API unavailable */ }
    }).catch(() => {});
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('git-graph-plus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
    }),
    vscode.commands.registerCommand('gitGraphPlus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
      /* SNIPCODE-HOOK start: webview boot handshake (e2e strategy #20)
         Return the readiness promise so `executeCommand('gitGraphPlus.open')`
         resolves only after the webview's first message (or rejects on boot
         failure). The no-op catch prevents an unhandled rejection when the
         caller doesn't await; awaiting callers still observe the rejection. */
      const ready = MainPanel.currentPanel?.whenWebviewReady();
      ready?.catch(() => {});
      return ready;
      /* SNIPCODE-HOOK end */
    }),
    vscode.commands.registerCommand('gitGraphPlus.refresh', () => {
      refreshAll();
      MainPanel.currentPanel?.postRefresh();
    }),
    vscode.commands.registerCommand('gitGraphPlus.fetch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'fetch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pull', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'pull' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.push', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.publishBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutBranch', (branchItem) => {
      if (branchItem?.branch) {
        activeGitService.checkout(branchItem.branch.name).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranch', (branchItem) => {
      if (branchItem?.branch) {
        const ref = branchItem.branch.name; // e.g. origin/main
        const localName = ref.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: ref, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.mergeBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'mergeBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashApply', (stashItem) => {
      const index = stashItem?.index ?? 0;
      activeGitService.stashApply(index).then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashPop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashPop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createBranch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashSave', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashSave' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createTag', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createTag' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        activeGitService.pushTag(tagName).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
          vscode.window.showInformationMessage(`Pushed tag ${tagName}`);
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushAllTags', () => {
      activeGitService.pushAllTags().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pushed all tags`);
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.renameBranch', (branchItem) => {
      const oldName = branchItem?.branch?.name;
      if (oldName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'renameBranch', branchName: oldName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashDrop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashDrop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.addWorktree', async () => {
      const defaultPath = await resolveDefaultWorktreePath(activeGitService, activeRepoPath);
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'addWorktree', defaultPath });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pruneWorktrees', () => {
      activeGitService.worktreePrune().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pruned worktrees`);
      }).catch((err: Error) => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.showRemoteBranchMenu', (branchItem) => {
      const branch = branchItem?.branch;
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        vscode.window.showQuickPick([
          { label: `Checkout as local branch...`, id: 'checkout' },
          { label: `Delete remote branch ${branch.name}`, id: 'delete' },
        ]).then(selected => {
          if (selected?.id === 'delete') {
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
          } else if (selected?.id === 'checkout') {
            const localName = branchName;
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
          }
        });
      }
    }),
    /* SNIPCODE-HOOK start: whole-branch copy/restore via git format-patch / am */
    ...(() => {
      /** Copy a branch as an mbox. There is deliberately no "last N commits"
       *  option: `branch~N` walks first parents only, so on a history with
       *  merges the count is wildly misleading — on this very repo `main~5..main`
       *  spans 119 commits, not 5. The only bases a user can reason about are
       *  the fork point and the root, so those are the only two on offer, and
       *  the fork point needs no asking. */
      const copySeries = async (branchItem: unknown, fullHistory: boolean) => {
        const item = branchItem as { branch?: { name?: string } } | undefined;
        const branch = item?.branch?.name ?? branchesProvider.getCurrentItem()?.branch.name;
        if (!branch) return;
        try {
          let base: string | null = null;
          if (!fullHistory) {
            const locals = (await activeGitService.branches())
              .filter(b => !b.remote && !b.detached).map(b => b.name).filter(n => n !== branch);
            const onto = ['main', 'master', 'develop', 'dev', 'trunk'].find(p => locals.includes(p))
              ?? (await vscode.window.showQuickPick(locals, { placeHolder: `Copy ${branch}: commits since which branch?` }));
            if (!onto) return;
            base = await activeGitService.mergeBase(onto, branch);
            if (!base) {
              vscode.window.showErrorMessage(`${branch} and ${onto} share no history — use "Copy Branch Commits (Entire History)".`);
              return;
            }
          }

          const { mbox, count } = await activeGitService.exportBranchSeries(branch, base);
          if (count === 0) {
            // Almost always means the branch is already merged. Offer the one
            // thing that still has something to copy rather than a dead end.
            const go = await vscode.window.showInformationMessage(
              `${branch} has no commits of its own — it is already merged into the main branch.`,
              'Copy Entire History'
            );
            if (go === 'Copy Entire History') await copySeries(branchItem, true);
            return;
          }

          // The clipboard is the transport here, and a multi-year history can
          // run to tens of MB — warn before pushing something the OS may choke
          // on. (This repo's 214 commits come to ~16 MB.)
          const megabytes = Buffer.byteLength(mbox, 'utf8') / (1024 * 1024);
          if (megabytes > 8) {
            const go = await vscode.window.showWarningMessage(
              `This is ${megabytes.toFixed(1)} MB of patch text (${count} commits). Clipboards this large are slow and some editors truncate them.`,
              { modal: true, detail: 'For a history this size, sharing the repo itself (a remote, or git bundle) is usually the better move.' },
              'Copy Anyway'
            );
            if (go !== 'Copy Anyway') return;
          }

          await vscode.env.clipboard.writeText(mbox);
          vscode.window.showInformationMessage(
            base
              ? `Copied ${count} commit${count === 1 ? '' : 's'} from ${branch}. Restoring needs commit ${base.slice(0, 8)} on the other side.`
              : `Copied ${count} commit${count === 1 ? '' : 's'} from ${branch} — self-contained, restores into any repo.`
          );
        } catch (err) {
          vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
      };
      return [
        vscode.commands.registerCommand('snipcode.git.copyBranchSeries', (i) => copySeries(i, false)),
        vscode.commands.registerCommand('snipcode.git.copyBranchSeriesFull', (i) => copySeries(i, true)),
      ];
    })(),
    vscode.commands.registerCommand('snipcode.git.pasteBranchSeries', async () => {
      try {
        const mbox = await vscode.env.clipboard.readText();
        if (!/^From [0-9a-f]{7,64} /m.test(mbox)) {
          vscode.window.showErrorMessage('The clipboard does not hold a branch copied by Snipcode.');
          return;
        }
        if (!await activeGitService.isWorkingTreeClean()) {
          vscode.window.showErrorMessage('Commit or stash your local changes first — restoring a branch needs a clean working tree.');
          return;
        }

        const name = await vscode.window.showInputBox({
          prompt: 'Name for the restored branch',
          placeHolder: 'e.g. restored/feature-x',
          validateInput: v => !v.trim() ? 'Branch name is required'
            : /[\s~^:?*[\\]|^-|\.\.|@\{/.test(v) ? 'Not a valid branch name' : undefined,
        });
        if (!name) return;

        // format-patch wrote the start point into the payload. Its presence is
        // also what tells the two kinds of copy apart: a trailer means a partial
        // series that needs that commit locally, no trailer means the history
        // runs back to the root and stands on its own.
        const base = mbox.match(/^base-commit: ([0-9a-f]{7,64})$/m)?.[1];
        const branchName = name.trim();

        if (!base) {
          const go = await vscode.window.showWarningMessage(
            'This copy carries a full history, so it restores onto an empty branch. Tracked files will be cleared from the working tree — they stay on the branch you are leaving.',
            { modal: true }, 'Restore'
          );
          if (go !== 'Restore') return;
          await activeGitService.createOrphanBranch(branchName);
        } else if (await activeGitService.hasCommit(base)) {
          await activeGitService.createAndCheckoutBranch(branchName, base);
        } else {
          // Without the base commit, git cannot rebuild the ancestor blobs, so
          // every commit that edits a pre-existing file fails. Say so up front
          // rather than letting it die on "could not build fake ancestor".
          const go = await vscode.window.showWarningMessage(
            `This copy starts from commit ${base.slice(0, 8)}, which is not in this repository.`,
            {
              modal: true,
              detail: 'Commits that edit files already present will fail to apply. Fetch that commit first, or re-copy on the source side with "Entire history" to get a self-contained payload.',
            },
            'Try on Current HEAD'
          );
          if (go !== 'Try on Current HEAD') return;
          await activeGitService.createAndCheckoutBranch(branchName);
        }
        try {
          await activeGitService.applyBranchSeries(mbox);
        } catch (err) {
          const pick = await vscode.window.showErrorMessage(
            `Restore stopped on a conflict: ${err instanceof Error ? err.message : String(err)}`,
            'Abort Restore', 'Keep and Resolve'
          );
          if (pick === 'Abort Restore') { await activeGitService.abortBranchSeries(); }
          return;
        } finally {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
        }
        vscode.window.showInformationMessage(`Restored the branch as ${name.trim()}.`);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    /* SNIPCODE-HOOK end */
    vscode.commands.registerCommand('gitGraphPlus.showBranchMenu', (branchItem) => {
      const branch = branchItem?.branch;
      if (branch) {
        /* SNIPCODE-HOOK start: S16 hide Checkout/Delete for the current branch */
        // Checking out or deleting the branch you're already on makes no sense
        // (the context menu already excludes both for `branch-current`).
        vscode.window.showQuickPick([
          ...(branch.current ? [] : [{ label: `Checkout ${branch.name}`, id: 'checkout' }]),
          { label: `Merge into current branch...`, id: 'merge' },
          /* SNIPCODE-HOOK start: whole-branch copy */
          { label: `Copy all commits on ${branch.name}`, id: 'copySeries' },
          /* SNIPCODE-HOOK end */
          { label: `Rename ${branch.name}...`, id: 'rename' },
          ...(branch.current ? [] : [{ label: `Delete ${branch.name}...`, id: 'delete' }]),
        ]).then(selected => {
          /* SNIPCODE-HOOK end */
          if (!selected) return;
          switch (selected.id) {
            case 'checkout': vscode.commands.executeCommand('gitGraphPlus.checkoutBranch', branchItem); break;
            case 'merge': vscode.commands.executeCommand('gitGraphPlus.mergeBranch', branchItem); break;
            /* SNIPCODE-HOOK start: whole-branch copy */
            case 'copySeries': vscode.commands.executeCommand('snipcode.git.copyBranchSeries', branchItem); break;
            /* SNIPCODE-HOOK end */
            case 'rename': vscode.commands.executeCommand('gitGraphPlus.renameBranch', branchItem); break;
            case 'delete': vscode.commands.executeCommand('gitGraphPlus.deleteBranch', branchItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.showTagMenu', (tagItem) => {
      const tag = tagItem?.tag;
      if (tag) {
        vscode.window.showQuickPick([
          /* SNIPCODE-HOOK start: S16 Tag QuickPick gets a Checkout option too (context menu already has one) */
          { label: `Checkout ${tag.name}`, id: 'checkout' },
          /* SNIPCODE-HOOK end */
          { label: `Push ${tag.name} to remote`, id: 'push' },
          { label: `Delete tag ${tag.name}`, id: 'delete' },
          { label: `Delete remote tag ${tag.name}`, id: 'deleteRemote' },
        ]).then(selected => {
          if (!selected) return;
          switch (selected.id) {
            /* SNIPCODE-HOOK start: S16 Tag QuickPick gets a Checkout option too (context menu already has one) */
            case 'checkout':
              activeGitService.checkout(tag.name).then(() => {
                refreshAll();
                MainPanel.currentPanel?.postRefresh();
              }).catch(err => vscode.window.showErrorMessage(err.message));
              break;
            /* SNIPCODE-HOOK end */
            case 'push': vscode.commands.executeCommand('gitGraphPlus.pushTag', tagItem); break;
            case 'delete': vscode.commands.executeCommand('gitGraphPlus.deleteTag', tagItem); break;
            case 'deleteRemote': vscode.commands.executeCommand('gitGraphPlus.deleteRemoteTag', tagItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.showStashMenu', (stashItem) => {
      const stash = stashItem?.stash;
      if (stash) {
        vscode.window.showQuickPick([
          { label: `Apply stash@{${stash.index}}`, id: 'apply' },
          { label: `Pop stash@{${stash.index}}`, id: 'pop' },
          { label: `Drop stash@{${stash.index}}`, id: 'drop' },
        ]).then(selected => {
          if (!selected) return;
          switch (selected.id) {
            case 'apply': vscode.commands.executeCommand('gitGraphPlus.stashApply', stashItem); break;
            case 'pop': vscode.commands.executeCommand('gitGraphPlus.stashPop', stashItem); break;
            case 'drop': vscode.commands.executeCommand('gitGraphPlus.stashDrop', stashItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranchExplicit', (branch) => {
      if (branch) {
        const localName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteBranchExplicit', (branch) => {
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.openWorktree', openWorktree),
    vscode.commands.registerCommand('gitGraphPlus.openWorktreeInFileExplorer', openWorktreeInFileExplorer),
    vscode.commands.registerCommand('gitGraphPlus.removeWorktree', (wtItem) => {
      if (wtItem?.worktree) {
        const wtPath = wtItem.worktree.path;
        const wtBranch = wtItem.worktree.branch;
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'removeWorktree', path: wtPath, branch: wtBranch });
      }
    }),
  );
}

export function deactivate() {
  MainPanel.onSidebarRefresh = null;
  MainPanel.onRepoChange = null;
  MainPanel.setGitServiceProvider(null);
}
