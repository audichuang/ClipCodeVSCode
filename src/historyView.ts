import * as vscode from 'vscode';
import { type HistoryRepo, readClassifiedAtCommit } from './gitHistory.js';
import { collectHistoryCopy, historyCopyNotice, historyGitPaths } from './historyCopy.js';
import { makeChangedPathLister, makeRawBlobReader, withRawBlobs } from './gitRawBlob.js';
import { dedupeFilesKeepNewest, type FileNode, resolveSourceNodes } from './historyTree.js';
import { type HistoryNode, HistoryTreeProvider } from './historyTreeProvider.js';
import { askAboutNonText } from './nonTextDialog.js';
import { notifyCopied } from './notify.js';
import { normalizeSettings, type ClipCodeSettings, type FilterRule } from './settings.js';

interface GitExtension { readonly enabled: boolean; readonly onDidChangeEnablement: vscode.Event<boolean>; getAPI(version: 1): GitAPI; }
interface GitAPI { readonly git?: { readonly path?: string }; readonly repositories: HistoryRepo[]; readonly onDidOpenRepository: vscode.Event<HistoryRepo>; readonly onDidCloseRepository: vscode.Event<HistoryRepo>; }

const LAST_REPO_KEY = 'clipcode.history.lastRepoRoot';

export function registerHistoryView(context: vscode.ExtensionContext): void {
  const provider = new HistoryTreeProvider();
  const treeView = vscode.window.createTreeView('clipcode.history', { treeDataProvider: provider, canSelectMany: true });
  context.subscriptions.push(treeView, provider, { dispose: () => apiListeners?.dispose() });

  let api: GitAPI | undefined;
  let apiListeners: vscode.Disposable | undefined;

  const pickInitialRepo = (): HistoryRepo | undefined => {
    if (!api || api.repositories.length === 0) return undefined;
    const remembered = context.workspaceState.get<string>(LAST_REPO_KEY);
    const byRemembered = api.repositories.find(r => r.rootUri.toString() === remembered);
    if (byRemembered) return byRemembered;
    const selected = api.repositories.find(r => (r as any).ui?.selected === true);
    return selected ?? api.repositories[0];
  };

  const useRepo = (repo: HistoryRepo | undefined) => {
    provider.setRepo(repo);
    if (repo) void context.workspaceState.update(LAST_REPO_KEY, repo.rootUri.toString());
    treeView.description = repo ? basename(repo.rootUri.fsPath) : undefined;
  };

  const repickIfNeeded = () => { if (!provider.repo || !currentRepoStillOpen()) useRepo(pickInitialRepo()); };
  const wireApi = (gitApi: GitAPI) => {
    api = gitApi;
    apiListeners?.dispose(); // drop stale listeners from a previous enable cycle
    apiListeners = vscode.Disposable.from(
      gitApi.onDidOpenRepository(repickIfNeeded),
      gitApi.onDidCloseRepository(repickIfNeeded),
    );
    repickIfNeeded();
  };
  const disableApi = () => { api = undefined; apiListeners?.dispose(); apiListeners = undefined; useRepo(undefined); };
  const currentRepoStillOpen = () =>
    !!provider.repo && !!api?.repositories.some(r => r.rootUri.toString() === provider.repo!.rootUri.toString());

  // Git enabled 守衛:getAPI 在停用時會丟例外
  const tryAcquire = (ext: vscode.Extension<GitExtension>) => {
    const exports = ext.isActive ? ext.exports : undefined;
    const init = (gx: GitExtension) => {
      const enable = () => { try { wireApi(gx.getAPI(1)); } catch { /* Git disabled mid-flight */ } };
      if (gx.enabled) enable();
      context.subscriptions.push(gx.onDidChangeEnablement(en => {
        if (en) { if (!api) enable(); } else disableApi();
      }));
    };
    if (exports) init(exports); else void ext.activate().then(init);
  };
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (gitExt) tryAcquire(gitExt);

  context.subscriptions.push(
    vscode.commands.registerCommand('clipcode.history.loadMore', () => provider.loadMore()),
    vscode.commands.registerCommand('clipcode.history.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('clipcode.history.switchRepository', async () => {
      if (!api || api.repositories.length === 0) { vscode.window.showWarningMessage('No Git repositories found.'); return; }
      const pick = await vscode.window.showQuickPick(
        api.repositories.map(r => ({ label: basename(r.rootUri.fsPath), repo: r })),
        { placeHolder: 'Select a repository' }
      );
      if (pick) useRepo(pick.repo);
    }),
    vscode.commands.registerCommand('clipcode.history.copyFullSource', async (clicked?: HistoryNode, selected?: HistoryNode[]) => {
      await copyFullSource(provider, treeView, resolveSourceNodes(clicked, selected, treeView.selection), api?.git?.path ?? 'git');
    }),
  );
}

async function copyFullSource(
  provider: HistoryTreeProvider, treeView: vscode.TreeView<HistoryNode>, sources: HistoryNode[], gitPath: string
): Promise<void> {
  if (sources.length === 0) { vscode.window.showWarningMessage('No files selected.'); return; }
  const settings = readSettings();
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  const collected: FileNode[] = [];
  try {
    for (const node of sources) collected.push(...await provider.getFilesForNode(node));
  } catch (error) {
    // The shallow-clone guard refuses here rather than copy the whole repository tree.
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }
  const files = dedupeFilesKeepNewest(collected);
  // Raw blob reads (`git cat-file`): the Git extension's buffer() applies textconv.
  const repo = withRawBlobs(provider.repo!, makeRawBlobReader(gitPath));
  // The git spelling of each path, for the "Name not portable" check (decision X1).
  const gitPaths = await historyGitPaths(files, makeChangedPathLister(gitPath));

  const result = await askAboutNonText(
    settings,
    includeNonText => collectHistoryCopy(
      files, f => readClassifiedAtCommit(repo, f.commit.hash, f.change, f.commit.parents), settings, roots, { includeNonText, gitPaths }),
    (message, options, ...buttons) => vscode.window.showWarningMessage(message, options, ...buttons)
  );
  if (!result) return;

  const notice = historyCopyNotice(result, settings);
  // Nothing to copy: one warning, naming the unreadable files too (case 30); clipboard untouched.
  if (notice.emptyWarning !== undefined) { vscode.window.showWarningMessage(notice.emptyWarning); return; }
  if (notice.unresolvedWarning) vscode.window.showWarningMessage(notice.unresolvedWarning);
  await vscode.env.clipboard.writeText(result.payload);
  if (settings.showCopyNotification) notifyCopied(notice.message, result.payload);
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }

function readSettings(): ClipCodeSettings {
  const c = vscode.workspace.getConfiguration('clipcode');
  return normalizeSettings({
    headerFormat: c.get('headerFormat'), preText: c.get('preText'), postText: c.get('postText'),
    addExtraLineBetweenFiles: c.get('addExtraLineBetweenFiles'), setMaxFileCount: c.get('setMaxFileCount'),
    fileCountLimit: c.get('fileCountLimit'), maxFileSizeKB: c.get('maxFileSizeKB'),
    maxNonTextFileSizeKB: c.get('maxNonTextFileSizeKB'), showCopyNotification: c.get('showCopyNotification'),
    useFilters: c.get('useFilters'), useIncludeFilters: c.get('useIncludeFilters'), useExcludeFilters: c.get('useExcludeFilters'),
    filterRules: c.get<FilterRule[]>('filterRules'),
  });
}
