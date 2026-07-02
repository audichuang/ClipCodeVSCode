import * as vscode from 'vscode';
import { candidateBaseRefs, diffNameStatus, remoteStatus, type DiffFile } from './branchDiff.js';
import { formatBanner, toGraphCopyPayload } from './prCopyService.js';
import { buildGraphCopyPayload } from './graphCopy.js';
import { makeGraphCopyDeps } from './extension.js';
import { collectPrFileNodes, PrTreeProvider, type PrNode, type PrTreeNode } from './prTreeProvider.js';
import { resolveSourceNodes } from './historyTree.js';
import { normalizeSettings, type ClipCodeSettings, type FilterRule } from './settings.js';

interface PrRepo { readonly rootUri: vscode.Uri; }
interface GitExtension { readonly enabled: boolean; readonly onDidChangeEnablement: vscode.Event<boolean>; getAPI(version: 1): GitAPI; }
interface GitAPI {
  readonly repositories: PrRepo[];
  readonly git?: { path?: string };
  readonly onDidOpenRepository: vscode.Event<PrRepo>;
  readonly onDidCloseRepository: vscode.Event<PrRepo>;
}

const LAST_REPO_KEY = 'clipcode.pr.lastRepoRoot';

// Registers the PR tree-view panel: clones src/historyView.ts's git-API
// acquisition + repo-selection skeleton, then wires base selection / fetch /
// refresh / copy commands around branchDiff.ts + prCopyService.ts.
export function registerPrPanel(context: vscode.ExtensionContext): void {
  const provider = new PrTreeProvider();
  const treeView = vscode.window.createTreeView<PrNode>('clipcode.prPanel', {
    treeDataProvider: provider,
    canSelectMany: true,
    manageCheckboxStateManually: true
  });

  let api: GitAPI | undefined;
  let apiListeners: vscode.Disposable | undefined;
  let repo: PrRepo | undefined;
  let currentBase: string | undefined;
  let currentDiff: DiffFile[] = [];
  let reloadGeneration = 0;

  context.subscriptions.push(
    treeView,
    provider,
    { dispose: () => apiListeners?.dispose() },
    treeView.onDidChangeCheckboxState(e => {
      for (const [node, state] of e.items) {
        if (node.kind === 'file') provider.setChecked(node, state);
      }
    })
  );

  const pickInitialRepo = (): PrRepo | undefined => {
    if (!api || api.repositories.length === 0) return undefined;
    const remembered = context.workspaceState.get<string>(LAST_REPO_KEY);
    const byRemembered = api.repositories.find(r => r.rootUri.toString() === remembered);
    if (byRemembered) return byRemembered;
    const selected = api.repositories.find(r => (r as any).ui?.selected === true);
    return selected ?? api.repositories[0];
  };

  const useRepo = (next: PrRepo | undefined) => {
    repo = next;
    if (repo) void context.workspaceState.update(LAST_REPO_KEY, repo.rootUri.toString());
    treeView.title = repo ? `Snipcode PR — ${basename(repo.rootUri.fsPath)}` : 'Snipcode PR';
    currentBase = undefined;
    currentDiff = [];
    treeView.message = undefined;
    provider.reset();
  };

  const currentRepoStillOpen = () =>
    !!repo && !!api?.repositories.some(r => r.rootUri.toString() === repo!.rootUri.toString());
  const repickIfNeeded = () => { if (!repo || !currentRepoStillOpen()) useRepo(pickInitialRepo()); };

  const wireApi = (gitApi: GitAPI) => {
    api = gitApi;
    apiListeners?.dispose(); // drop stale listeners from a previous enable cycle
    apiListeners = vscode.Disposable.from(
      gitApi.onDidOpenRepository(repickIfNeeded),
      gitApi.onDidCloseRepository(repickIfNeeded)
    );
    repickIfNeeded();
  };
  const disableApi = () => { api = undefined; apiListeners?.dispose(); apiListeners = undefined; useRepo(undefined); };

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

  const gitPath = () => api?.git?.path ?? 'git';

  // Lessons 1+2 from Global Constraints: remoteStatus(doFetch) — which does the
  // fetch — MUST resolve before diffNameStatus, and a reloadGeneration counter
  // (checked together with the still-current baseRef) discards a stale reload
  // that lost a race against a newer one.
  const reload = async (baseRef: string, doFetch: boolean): Promise<void> => {
    if (!repo) return;
    const root = repo.rootUri.fsPath;
    const gp = gitPath();
    const generation = ++reloadGeneration;
    currentBase = baseRef;
    const status = await remoteStatus(gp, root, doFetch, baseRef);
    const diff = await diffNameStatus(gp, root, baseRef);
    if (generation !== reloadGeneration || currentBase !== baseRef) return;
    currentDiff = diff;
    treeView.message = formatBanner(status);
    provider.setFiles(diff);
  };

  const doCopy = async (paths: ReadonlySet<string>): Promise<void> => {
    if (!repo) { vscode.window.showWarningMessage('No Git repository selected.'); return; }
    if (paths.size === 0) { vscode.window.showWarningMessage('No files selected.'); return; }
    const settings = readSettings();
    const payload = toGraphCopyPayload(repo.rootUri.fsPath, currentDiff, paths);
    const deps = makeGraphCopyDeps(api as unknown as Parameters<typeof makeGraphCopyDeps>[0], settings);
    const result = await buildGraphCopyPayload(deps, payload);
    await vscode.env.clipboard.writeText(result.text);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('clipcode.pr.selectBase', async () => {
      if (!repo) { vscode.window.showWarningMessage('No Git repositories found.'); return; }
      const refs = await candidateBaseRefs(gitPath(), repo.rootUri.fsPath);
      if (refs.length === 0) { vscode.window.showWarningMessage('No remote branches found to compare against.'); return; }
      const pick = await vscode.window.showQuickPick(refs, { placeHolder: 'Select a base branch (base..HEAD)' });
      if (pick) await reload(pick, false);
    }),
    vscode.commands.registerCommand('clipcode.pr.fetch', async () => {
      if (currentBase) await reload(currentBase, true);
    }),
    vscode.commands.registerCommand('clipcode.pr.refresh', async () => {
      if (currentBase) await reload(currentBase, true);
    }),
    vscode.commands.registerCommand('clipcode.pr.copyAll', async () => {
      await doCopy(provider.getCheckedPaths());
    }),
    vscode.commands.registerCommand('clipcode.pr.copySelected', async (clicked?: PrNode, selected?: PrNode[]) => {
      const nodes = resolveSourceNodes(clicked, selected, treeView.selection)
        .filter((n): n is PrTreeNode => n.kind !== 'message');
      const paths = new Set(nodes.flatMap(n => collectPrFileNodes(n).map(f => f.relPath)));
      await doCopy(paths);
    })
  );
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }

function readSettings(): ClipCodeSettings {
  const c = vscode.workspace.getConfiguration('clipcode');
  return normalizeSettings({
    headerFormat: c.get('headerFormat'), preText: c.get('preText'), postText: c.get('postText'),
    addExtraLineBetweenFiles: c.get('addExtraLineBetweenFiles'), setMaxFileCount: c.get('setMaxFileCount'),
    fileCountLimit: c.get('fileCountLimit'), maxFileSizeKB: c.get('maxFileSizeKB'), showCopyNotification: c.get('showCopyNotification'),
    useFilters: c.get('useFilters'), useIncludeFilters: c.get('useIncludeFilters'), useExcludeFilters: c.get('useExcludeFilters'),
    filterRules: c.get<FilterRule[]>('filterRules')
  });
}
