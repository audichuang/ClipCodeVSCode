import * as vscode from 'vscode';
import { buildGitPayload, buildPayload, parseClipboard, type ChangeTypeLabel, type PayloadFile } from './clipboardFormat.js';
import { collectCopyFiles, collectCopyTextFiles, type CopyTextFile } from './copy.js';
import { fileMatchesFilters } from './filterMatcher.js';
import { decodeText, isTextContent, normalizeFsPath, readRefContent } from './gitContent.js';
import { DELETED_FILE_MARKER, isStagedGitStatus, mapGitStatusToChangeType } from './gitCopy.js';
import { registerHistoryView } from './historyView.js';
import { toClipboardPathFromRoots } from './pathResolver.js';
import { executeRestorePlan, planRestore } from './restore.js';
import { normalizeSettings, type ClipCodeSettings, type FilterRule } from './settings.js';

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: GitRepository[];
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    indexChanges?: GitChange[];
    workingTreeChanges?: GitChange[];
    untrackedChanges?: GitChange[];
    mergeChanges?: GitChange[];
  };
  show?: (ref: string, path: string) => Promise<string>;
  buffer?: (ref: string, path: string) => Promise<Uint8Array>;
}

interface GitChange {
  uri: vscode.Uri;
  originalUri?: vscode.Uri;
  renameUri?: vscode.Uri;
  status: unknown;
}

interface GitSelection {
  uriKey: string;
  status?: unknown;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clipcode.copyToClipboard', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      await copySelectedFiles(uri, uris);
    }),
    vscode.commands.registerCommand('clipcode.copyAllOpenEditors', async () => {
      await copyAllOpenEditors();
    }),
    vscode.commands.registerCommand('clipcode.copyGitChanges', async (...resources: unknown[]) => {
      await copyGitChanges(resources);
    }),
    vscode.commands.registerCommand('clipcode.pasteAndRestoreFiles', async () => {
      await pasteAndRestoreFiles();
    })
  );
  registerHistoryView(context);

  // Vendored git-graph-plus host adapter (S5). Imported lazily so `tsc -p ./`
  // (which emits out/ for node:test of the pure-logic modules) never pulls the
  // graph/ tree into its program — only the esbuild host bundle binds it. The
  // import is typed as the activateGraph contract from spec §4.0.
  const { activateGraph } = require('../graph/src/extension') as {
    activateGraph: (
      context: vscode.ExtensionContext,
      opts: {
        assetRootUri: vscode.Uri;
        copyFullSourceAtCommit: (payload: { hash: string; files: unknown[] }) => Promise<void>;
      },
    ) => void;
  };
  // Webview assets ship under dist/graph-webview (see esbuild build script).
  const assetRootUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'graph-webview');
  activateGraph(context, {
    assetRootUri,
    // Task 1 dummy handler; replaced by the real copyFullSourceAtCommit in Task 3.
    copyFullSourceAtCommit: async () => {
      vscode.window.showInformationMessage('snipcode dummy ok');
    },
  });
}

export function deactivate(): void {}

async function copySelectedFiles(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const selectedUris = collectSelectedUris(uri, uris);
  if (selectedUris.length === 0) {
    vscode.window.showWarningMessage('No files selected.');
    return;
  }

  const roots = workspaceRootPaths();
  if (roots.length === 0) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }

  const settings = readSettings();
  const result = await collectCopyFiles(roots, selectedUris.map(item => item.fsPath), settings);
  await vscode.env.clipboard.writeText(result.payload);
  if (settings.showCopyNotification) {
    const suffix = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
    vscode.window.showInformationMessage(`${result.copiedFileCount} file(s) copied${suffix}.`);
  }
}

async function copyAllOpenEditors(): Promise<void> {
  const roots = workspaceRootPaths();
  if (roots.length === 0) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }

  const settings = readSettings();
  const files: CopyTextFile[] = [];
  const seen = new Set<string>();

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const document = await vscode.workspace.openTextDocument(tab.input.uri);
      if (document.isUntitled || document.uri.scheme !== 'file' || document.getText() === '') continue;
      const absolutePath = document.uri.fsPath;
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      files.push({
        absolutePath,
        content: document.getText()
      });
    }
  }

  const result = await collectCopyTextFiles(roots, files, settings);
  if (result.files.length === 0) {
    vscode.window.showInformationMessage('No open text editors found to copy.');
    return;
  }

  await vscode.env.clipboard.writeText(result.payload);
  if (settings.showCopyNotification) {
    const suffix = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
    vscode.window.showInformationMessage(`${result.copiedFileCount} open editor file(s) copied${suffix}.`);
  }
}

async function copyGitChanges(resources: unknown[]): Promise<void> {
  const roots = workspaceRootPaths();
  if (roots.length === 0) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }

  const api = await getGitApi();
  if (!api || api.repositories.length === 0) {
    vscode.window.showWarningMessage('No Git repositories found.');
    return;
  }

  const selected = collectResourceSelections(resources);
  const settings = readSettings();
  const result = await collectGitPayloadFiles(api.repositories, roots, selected, settings);

  if (result.files.length === 0) {
    vscode.window.showWarningMessage('No Git changes found to copy.');
    return;
  }

  const payloadOptions = {
    headerFormat: settings.headerFormat,
    preText: settings.preText,
    postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
    files: result.files
  };
  const payload = result.usesRegularSpacing
    ? buildPayload(payloadOptions)
    : buildGitPayload(payloadOptions);
  await vscode.env.clipboard.writeText(payload);

  if (settings.showCopyNotification) {
    const skipped = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
    const limit = result.fileLimitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
    vscode.window.showInformationMessage(`${result.copiedFileCount} Git file(s) copied${skipped}.${limit}`);
  }
}

async function pasteAndRestoreFiles(): Promise<void> {
  const roots = workspaceRootPaths();
  if (roots.length === 0) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }

  const settings = readSettings();
  const clipboardText = await vscode.env.clipboard.readText();
  if (!clipboardText.trim()) {
    vscode.window.showWarningMessage('Clipboard is empty or does not contain text.');
    return;
  }

  const entries = parseClipboard(clipboardText, settings.headerFormat);
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No Snipcode file headers found in clipboard.');
    return;
  }

  const plan = await planRestore(roots, entries);
  if (plan.createOperations.length === 0 && plan.deleteOperations.length === 0) {
    vscode.window.showWarningMessage(`No actionable files found. Skipped ${plan.skippedOperations.length}.`);
    return;
  }

  const proceed = await vscode.window.showWarningMessage(
    confirmationSummary(plan),
    { modal: true },
    'Proceed'
  );
  if (proceed !== 'Proceed') return;

  let overwriteExisting = false;
  let skipExisting = false;
  const existing = plan.createOperations.filter(operation => operation.existed);
  if (existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${existing.length} file(s) already exist.`,
      { modal: true },
      'Overwrite All',
      'Skip Existing',
      'Cancel'
    );
    if (choice === 'Cancel' || choice === undefined) return;
    overwriteExisting = choice === 'Overwrite All';
    skipExisting = choice === 'Skip Existing';
  }

  const result = await executeRestorePlan(plan, { overwriteExisting, skipExisting });
  const parts = [
    result.createdCount > 0 ? `Created ${result.createdCount}` : '',
    result.overwrittenCount > 0 ? `Overwritten ${result.overwrittenCount}` : '',
    result.skippedExistingCount > 0 ? `Skipped ${result.skippedExistingCount}` : '',
    result.deletedCount > 0 ? `Deleted ${result.deletedCount}` : ''
  ].filter(Boolean);
  vscode.window.showInformationMessage(parts.length > 0 ? parts.join(', ') : 'No files changed.');
  if (result.errors.length > 0) {
    vscode.window.showErrorMessage(`Snipcode failed ${result.errors.length} operation(s): ${result.errors.slice(0, 3).join('; ')}`);
  }
}

function collectSelectedUris(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  if (uris && uris.length > 0) return uris;
  return uri ? [uri] : [];
}

function firstWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function workspaceRootPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
}

function readSettings(): ClipCodeSettings {
  const config = vscode.workspace.getConfiguration('clipcode');
  return normalizeSettings({
    headerFormat: config.get<string>('headerFormat'),
    preText: config.get<string>('preText'),
    postText: config.get<string>('postText'),
    addExtraLineBetweenFiles: config.get<boolean>('addExtraLineBetweenFiles'),
    setMaxFileCount: config.get<boolean>('setMaxFileCount'),
    fileCountLimit: config.get<number>('fileCountLimit'),
    maxFileSizeKB: config.get<number>('maxFileSizeKB'),
    showCopyNotification: config.get<boolean>('showCopyNotification'),
    useFilters: config.get<boolean>('useFilters'),
    useIncludeFilters: config.get<boolean>('useIncludeFilters'),
    useExcludeFilters: config.get<boolean>('useExcludeFilters'),
    filterRules: config.get<FilterRule[]>('filterRules')
  });
}

function confirmationSummary(plan: Awaited<ReturnType<typeof planRestore>>): string {
  const create = plan.createOperations.filter(operation => !operation.existed).length;
  const overwrite = plan.createOperations.filter(operation => operation.existed).length;
  const deleted = plan.deleteOperations.length;
  const skipped = plan.skippedOperations.length;
  return `Snipcode will create ${create}, overwrite ${overwrite}, delete ${deleted}, and skip ${skipped} operation(s).`;
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) return undefined;
  const extension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  return extension.getAPI(1);
}

async function collectGitPayloadFiles(
  repositories: GitRepository[],
  workspaceRoots: string[],
  selected: GitSelection[],
  settings: ClipCodeSettings
): Promise<{
  files: PayloadFile[];
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
  usesRegularSpacing: boolean;
}> {
  const files: PayloadFile[] = [];
  const seen = new Set<string>();
  let copiedFileCount = 0;
  let skippedFileSizeCount = 0;
  let fileLimitReached = false;
  let usesFallbackGitPayload = false;

  repositoryLoop:
  for (const repository of repositories) {
    for (const change of repositoryChanges(repository, selected.length === 0)) {
      if (selected.length > 0 && !gitChangeMatchesSelection(change, selected)) continue;

      if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
        fileLimitReached = true;
        break repositoryLoop;
      }

      const absolutePath = gitChangePath(change);
      const key = normalizeFsPath(absolutePath);
      if (seen.has(key)) continue;
      seen.add(key);

      const clipboardPath = toClipboardPathFromRoots(workspaceRoots, absolutePath);
      if (
        settings.useFilters &&
        !fileMatchesFilters(
          clipboardPath,
          settings.filterRules,
          settings.useIncludeFilters,
          settings.useExcludeFilters,
          absolutePath
        )
      ) {
        continue;
      }

      const changeType = mapGitStatusToChangeType(change.status);
      const forceIndexContent = selected.some(item =>
        item.uriKey === key && item.status !== undefined && sameStatus(item.status, change.status) && isStagedGitStatus(change.status)
      );
      const content = await readGitChangeContent(repository, change, changeType, forceIndexContent);
      if (content === undefined) continue;

      if (changeType === 'DELETED' || forceIndexContent) {
        usesFallbackGitPayload = true;
      }

      const size = Buffer.byteLength(content, 'utf8');
      if (size > settings.maxFileSizeKB * 1024) {
        skippedFileSizeCount++;
        files.push({
          path: clipboardPath,
          changeType,
          skippedReason: `size exceeds limit (${size} bytes)`
        });
        continue;
      }

      files.push({ path: clipboardPath, content, changeType });
      copiedFileCount++;
    }
  }

  return {
    files,
    copiedFileCount,
    skippedFileSizeCount,
    fileLimitReached,
    usesRegularSpacing: !usesFallbackGitPayload
  };
}

function repositoryChanges(repository: GitRepository, dedupeByPath: boolean): GitChange[] {
  const ordered = [
    ...(repository.state.workingTreeChanges ?? []),
    ...(repository.state.untrackedChanges ?? []),
    ...(repository.state.mergeChanges ?? []),
    ...(repository.state.indexChanges ?? [])
  ];
  const seen = new Set<string>();
  const result: GitChange[] = [];

  for (const change of ordered) {
    const key = normalizeFsPath(gitChangePath(change));
    if (dedupeByPath && seen.has(key)) continue;
    seen.add(key);
    result.push(change);
  }

  return result;
}

async function readGitChangeContent(
  repository: GitRepository,
  change: GitChange,
  changeType: ChangeTypeLabel,
  forceIndexContent: boolean
): Promise<string | undefined> {
  if (changeType === 'DELETED') {
    return await readRefContent(repository, 'HEAD', (change.originalUri ?? change.uri).fsPath) ??
      DELETED_FILE_MARKER;
  }

  if (forceIndexContent) {
    return await readRefContent(repository, '', change.uri.fsPath) ??
      await readWorkspaceText(change.uri);
  }

  return readWorkspaceText(change.uri);
}

async function readWorkspaceText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return decodeText(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function gitChangePath(change: GitChange): string {
  return (change.renameUri ?? change.uri).fsPath;
}

function gitChangeMatchesSelection(change: GitChange, selected: GitSelection[]): boolean {
  const keys = [change.uri, change.originalUri, change.renameUri]
    .filter((uri): uri is vscode.Uri => uri !== undefined)
    .map(uri => uriKey(uri));

  return selected.some(item =>
    keys.includes(item.uriKey) &&
    (item.status === undefined || sameStatus(item.status, change.status))
  );
}

function collectResourceSelections(values: unknown[]): GitSelection[] {
  const selections: GitSelection[] = [];
  for (const value of values) {
    selections.push(...extractResourceSelections(value));
  }
  return selections;
}

function extractResourceSelections(value: unknown): GitSelection[] {
  if (!value) return [];
  if (value instanceof vscode.Uri) return [{ uriKey: uriKey(value) }];
  if (Array.isArray(value)) return value.flatMap(extractResourceSelections);
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const status = record.type ?? record.status;
  const direct = [record.resourceUri, record.uri]
    .filter((uri): uri is vscode.Uri => uri instanceof vscode.Uri)
    .map(uri => ({ uriKey: uriKey(uri), status }));
  const nested = [record.resourceStates, record.resources]
    .flatMap(extractResourceSelections);
  return [...direct, ...nested];
}

function uriKey(uri: vscode.Uri): string {
  return normalizeFsPath(uri.fsPath);
}

function sameStatus(left: unknown, right: unknown): boolean {
  return normalizeStatus(left) === normalizeStatus(right);
}

function normalizeStatus(status: unknown): string {
  return typeof status === 'number'
    ? String(status)
    : String(status).trim().replace(/[\s-]+/g, '_').toUpperCase();
}
