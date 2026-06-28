import * as vscode from 'vscode';
import { buildGitPayload, buildPayload, type PayloadFile } from './clipboardFormat.js';
import { fileMatchesFilters } from './filterMatcher.js';
import { type HistoryRepo, readFileAtCommit } from './gitHistory.js';
import { dedupeFilesKeepNewest, type FileNode, resolveSourceNodes } from './historyTree.js';
import { type HistoryNode, HistoryTreeProvider } from './historyTreeProvider.js';
import { toClipboardPathFromRoots } from './pathResolver.js';
import { normalizeSettings, type ClipCodeSettings, type FilterRule } from './settings.js';

interface GitExtension { readonly enabled: boolean; readonly onDidChangeEnablement: vscode.Event<boolean>; getAPI(version: 1): GitAPI; }
interface GitAPI { readonly repositories: HistoryRepo[]; readonly onDidOpenRepository: vscode.Event<HistoryRepo>; readonly onDidCloseRepository: vscode.Event<HistoryRepo>; }

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
    treeView.title = repo ? `Snipcode History — ${basename(repo.rootUri.fsPath)}` : 'Snipcode History';
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
      await copyFullSource(provider, treeView, resolveSourceNodes(clicked, selected, treeView.selection));
    }),
  );
}

async function copyFullSource(provider: HistoryTreeProvider, treeView: vscode.TreeView<HistoryNode>, sources: HistoryNode[]): Promise<void> {
  if (sources.length === 0) { vscode.window.showWarningMessage('No files selected.'); return; }
  const settings = readSettings();
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  const collected: FileNode[] = [];
  for (const node of sources) collected.push(...await provider.getFilesForNode(node));
  const files = dedupeFilesKeepNewest(collected);

  const payloadFiles: PayloadFile[] = [];
  let copied = 0, skippedSize = 0, limitReached = false, usesFallback = false;
  for (const f of files) {
    if (settings.setMaxFileCount && copied >= settings.fileCountLimit) { limitReached = true; break; }
    const absPath = (f.change.renameUri ?? f.change.uri).fsPath;
    const clipboardPath = toClipboardPathFromRoots(roots.length ? roots : [f.repoRoot], absPath);
    if (settings.useFilters && !fileMatchesFilters(clipboardPath, settings.filterRules, settings.useIncludeFilters, settings.useExcludeFilters, absPath)) continue;

    const content = await readFileAtCommit(provider.repo!, f.commit.hash, f.change);
    if (content === undefined) continue;
    if (f.changeType === 'DELETED') usesFallback = true;

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedSize++; payloadFiles.push({ path: clipboardPath, changeType: f.changeType, skippedReason: `size exceeds limit (${size} bytes)` }); continue;
    }
    payloadFiles.push({ path: clipboardPath, content, changeType: f.changeType }); copied++;
  }

  if (payloadFiles.length === 0) { vscode.window.showWarningMessage('No Git changes found to copy.'); return; }
  const opts = { headerFormat: settings.headerFormat, preText: settings.preText, postText: settings.postText, addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles, files: payloadFiles };
  await vscode.env.clipboard.writeText(usesFallback ? buildGitPayload(opts) : buildPayload(opts));
  if (settings.showCopyNotification) {
    const s = skippedSize > 0 ? ` (${skippedSize} skipped: size exceeded)` : '';
    const l = limitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
    vscode.window.showInformationMessage(`${copied} Git file(s) copied${s}.${l}`);
  }
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }

function readSettings(): ClipCodeSettings {
  const c = vscode.workspace.getConfiguration('clipcode');
  return normalizeSettings({
    headerFormat: c.get('headerFormat'), preText: c.get('preText'), postText: c.get('postText'),
    addExtraLineBetweenFiles: c.get('addExtraLineBetweenFiles'), setMaxFileCount: c.get('setMaxFileCount'),
    fileCountLimit: c.get('fileCountLimit'), maxFileSizeKB: c.get('maxFileSizeKB'), showCopyNotification: c.get('showCopyNotification'),
    useFilters: c.get('useFilters'), useIncludeFilters: c.get('useIncludeFilters'), useExcludeFilters: c.get('useExcludeFilters'),
    filterRules: c.get<FilterRule[]>('filterRules'),
  });
}
