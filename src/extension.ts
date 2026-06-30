import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { formatBatchRequest, parseCatFileBatch } from './catFile.js';
import { applyRestoreBase, suggestRestoreBase, type DirProbe, type RestoreBase } from './restoreBase.js';
import { buildGitPayload, buildPayload, extractSourceRoot, parseClipboard, type ChangeTypeLabel, type PayloadFile } from './clipboardFormat.js';
import { collectCopyFiles, collectCopyTextFiles, type CopyTextFile } from './copy.js';
import { fileMatchesFilters } from './filterMatcher.js';
import { decodeText, isTextContent, normalizeFsPath, readRefContent, type ContentRepo } from './gitContent.js';
import { mapInOrder } from './concurrency.js';
import { buildGraphCopyPayload, type GraphCopyDeps, type GraphCopyPayload } from './graphCopy.js';
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
  git?: { path?: string };
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

export function activate(context: vscode.ExtensionContext): { copyFullSourceAtCommit: (payload: GraphCopyPayload) => Promise<void> } {
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
        copyFullSourceAtCommit: (payload: GraphCopyPayload) => Promise<void>;
      },
    ) => void;
  };
  // Webview assets ship under dist/graph-webview (see esbuild build script).
  const assetRootUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'graph-webview');
  activateGraph(context, { assetRootUri, copyFullSourceAtCommit });
  // VSCode exports — Task 7 E2E drives copyFullSourceAtCommit through this API.
  return { copyFullSourceAtCommit };
}

// Read every requested blob at `hash` in ONE `git cat-file --batch` process.
// vscode.git serializes per-repo show() calls, so this single process is far
// faster than N show() calls for a large "Copy Full Source". On any spawn error
// it resolves to an empty map and the caller falls back to per-file reads.
function readCommittedBatch(
  gitPath: string,
  repoRoot: string,
  hash: string,
  relativePaths: string[],
  gitEnv?: Record<string, string>
): Promise<Map<string, string | undefined>> {
  return new Promise(resolve => {
    if (relativePaths.length === 0) { resolve(new Map()); return; }
    let settled = false;
    const done = (v: Map<string, string | undefined>) => { if (!settled) { settled = true; resolve(v); } };
    try {
      // Mirror the graph's git env so the binary spawns identically (LC_ALL=C
      // keeps output byte-stable; gitEnv carries any host-specific git config).
      const env = { ...process.env, ...gitEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
      const child = spawn(gitPath, ['-C', repoRoot, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'], env });
      const chunks: Buffer[] = [];
      child.on('error', () => done(new Map()));
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stdout.on('error', () => done(new Map()));
      child.on('close', () => done(parseCatFileBatch(Buffer.concat(chunks), relativePaths)));
      child.stdin.on('error', () => {}); // ignore EPIPE if git exits early
      child.stdin.end(formatBatchRequest(hash, relativePaths));
    } catch {
      done(new Map());
    }
  });
}

function makeGraphCopyDeps(api: GitAPI, settings: ClipCodeSettings, runtime?: CopyRuntime): GraphCopyDeps {
  // Prefer the graph's resolved binary (validated git.path / VS Code Git's path)
  // over a bare 'git' that may not be on the extension-host PATH.
  const gitPath = runtime?.gitPath ?? api.git?.path ?? 'git';
  const gitEnv = runtime?.gitEnv;
  return {
    resolveRepo(repoRootFsPath: string): ContentRepo | undefined {
      const target = normalizeFsPath(repoRootFsPath);
      return api.repositories.find(r => normalizeFsPath(r.rootUri.fsPath) === target) as unknown as
        | ContentRepo
        | undefined;
    },
    // Working-tree read for the UNCOMMITTED view (no commit to `git show`).
    readWorking: (absolutePath: string) => readWorkspaceText(vscode.Uri.file(absolutePath)),
    readBatch: (repoRootFsPath, hash, relativePaths) =>
      readCommittedBatch(gitPath, repoRootFsPath, hash, relativePaths, gitEnv),
    settings,
  };
}

// The graph passes the git binary + env it actually uses for its own (working)
// git calls. Reading committed blobs with that same git is what makes the copy
// succeed on SSH-remote hosts where bare 'git' isn't on the spawn PATH.
interface CopyRuntime { gitPath?: string; gitEnv?: Record<string, string>; }

async function copyFullSourceAtCommit(payload: GraphCopyPayload, runtime?: CopyRuntime): Promise<void> {
  const api = await getGitApi();
  if (!api || api.repositories.length === 0) {
    vscode.window.showWarningMessage('No Git repositories found.');
    return;
  }
  const settings = readSettings();
  const result = await buildGraphCopyPayload(makeGraphCopyDeps(api, settings, runtime), payload);
  if (result.copiedFileCount === 0 && result.skippedFileSizeCount === 0) {
    vscode.window.showWarningMessage('No source copied.');
    return;
  }
  await vscode.env.clipboard.writeText(result.text);
  if (settings.showCopyNotification) {
    const skipped = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
    const limit = result.fileLimitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
    vscode.window.showInformationMessage(`${result.copiedFileCount} file(s) copied${skipped}.${limit}`);
  }
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
    files: result.files,
    // Single-root only: multi-root paths carry per-root labels, so a single
    // source-root basename would be wrong for files from other roots.
    sourceRoot: roots.length === 1 ? folderName(roots[0]) : undefined
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

function isRelativeEntryPath(p: string): boolean {
  // Reject POSIX absolutes, Windows drive paths (C:/ or C:\) and UNC (\\server).
  return !!p && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('\\');
}

function folderName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

// Detect a folder-level offset between the clipboard and this workspace — using
// the source-root metadata when present, otherwise an on-disk heuristic — and,
// only with the user's confirmation, return the base transform to apply to every
// path. Returns undefined to leave paths untouched, or 'cancel' to abort the paste.
async function confirmRestoreBaseOffset(
  primaryRoot: string,
  entries: Array<{ path: string }>,
  sourceRoot: string | undefined
): Promise<RestoreBase | undefined | 'cancel'> {
  const probe: DirProbe = {
    isDir: p => { try { return statSync(p).isDirectory(); } catch { return false; } },
    childDirs: root => {
      try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
      catch { return []; }
    }
  };
  const suggestion = suggestRestoreBase(primaryRoot, entries.map(e => e.path), probe, sourceRoot);
  if (!suggestion) return undefined;

  // Show a concrete before → after example so the choice is unambiguous.
  const sample = entries.map(e => e.path).find(p => isRelativeEntryPath(p) && p.includes('/'));
  const example = sample ? `\n\nExample: ${sample} → ${applyRestoreBase(suggestion.base, sample)}` : '';
  const choice = await vscode.window.showWarningMessage(
    `These paths look like they belong elsewhere in this workspace. I can ${suggestion.label} for all ${suggestion.total} file(s).${example}`,
    { modal: true },
    'Adjust Paths',
    'Use As-Is'
  );
  if (choice === 'Adjust Paths') return suggestion.base;
  if (choice === 'Use As-Is') return undefined;
  return 'cancel';
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

  let entries = parseClipboard(clipboardText, settings.headerFormat);
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No Snipcode file headers found in clipboard.');
    return;
  }

  // The bundle may have been copied from a different folder level than this
  // workspace (off by one wrapper dir). Detect that against the on-disk layout and
  // — only after the user confirms — adjust every path by the same offset. Limited
  // to single-root workspaces; multi-root relies on its sibling-root label scheme,
  // where a leading segment can legitimately be a root label, not a wrapper.
  if (roots.length === 1) {
    const adjusted = await confirmRestoreBaseOffset(roots[0], entries, extractSourceRoot(clipboardText));
    if (adjusted === 'cancel') return;
    if (adjusted) {
      entries = entries.map(e => ({ ...e, path: isRelativeEntryPath(e.path) ? applyRestoreBase(adjusted, e.path) : e.path }));
    }
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

// Each git change's content comes from one `git show` subprocess (staged /
// deleted files); fan them out instead of awaiting one at a time.
const GIT_READ_CONCURRENCY = 16;

interface GitChangeCandidate {
  repository: GitRepository;
  change: GitChange;
  clipboardPath: string;
  changeType: ChangeTypeLabel;
  forceIndexContent: boolean;
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

  // Phase 1 — selection / dedup / filter (no I/O, so order + dedup stay
  // deterministic). Produces the ordered candidate list.
  const candidates: GitChangeCandidate[] = [];
  for (const repository of repositories) {
    for (const change of repositoryChanges(repository, selected.length === 0)) {
      if (selected.length > 0 && !gitChangeMatchesSelection(change, selected)) continue;

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
      candidates.push({ repository, change, clipboardPath, changeType, forceIndexContent });
    }
  }

  // Phase 2 — fetch each candidate's content concurrently (the slow per-file
  // `git show`); Phase 3 — apply limit/size/order bookkeeping over the in-order
  // results so the payload is byte-identical to the old serial version. As with
  // the graph copy, tripping the limit mid-batch discards up to a batch of
  // already-issued reads (bounded over-fetch).
  const fetched = mapInOrder(candidates, GIT_READ_CONCURRENCY, async candidate => ({
    candidate,
    content: await readGitChangeContent(candidate.repository, candidate.change, candidate.changeType, candidate.forceIndexContent)
  }));
  for await (const { candidate, content } of fetched) {
    // The limit now trips only when a real candidate (post dedup/filter) is left
    // unread — so `fileLimitReached` reflects whether the limit actually dropped
    // a copyable file. The old serial loop checked before dedup/filter and could
    // flag the limit even when every remaining change was a dup/filtered no-op;
    // dropping that false positive is intentional.
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }
    if (content === undefined) continue;

    if (candidate.changeType === 'DELETED' || candidate.forceIndexContent) {
      usesFallbackGitPayload = true;
    }

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedFileSizeCount++;
      files.push({
        path: candidate.clipboardPath,
        changeType: candidate.changeType,
        skippedReason: `size exceeds limit (${size} bytes)`
      });
      continue;
    }

    files.push({ path: candidate.clipboardPath, content, changeType: candidate.changeType });
    copiedFileCount++;
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
