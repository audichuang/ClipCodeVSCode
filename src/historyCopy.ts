import { buildGitPayload, type PayloadFile } from './clipboardFormat.js';
import type { FileContent } from './fileSystem.js';
import { fileMatchesFilters } from './filterMatcher.js';
import type { FileNode } from './historyTree.js';
import { copyNoticeDetails, gitNothingToCopyNotice, type NonTextSummary } from './nonTextDialog.js';
import { LEFT_OUT_CAP, UNREADABLE_PATHS_KEPT } from './copy.js';
import { EMPTY_TREE } from './gitHistory.js';
import { nonPortableGitName, sourceRootName, toClipboardPathFromRoots } from './pathResolver.js';
import type { ClipCodeSettings } from './settings.js';

// The History view's "Copy Full Source" collection, kept free of `vscode` so it is unit
// tested; historyView.ts only feeds it the files and the reader and shows the result.

export interface HistoryCopyResult extends NonTextSummary {
  files: PayloadFile[];
  /** buildGitPayload of `files` (the Git layout, as IntelliJ's history copy uses). */
  payload: string;
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
  /** Names of files that could not be read at their commit. Excluded non-text files are not among them. */
  unresolved: string[];
  /** Exclude only: non-text files left out (read fine, so not in `unresolved`). */
  excludedNonTextCount: number;
}

export async function collectHistoryCopy(
  files: FileNode[],
  read: (file: FileNode) => Promise<FileContent | undefined>,
  settings: ClipCodeSettings,
  workspaceRoots: string[],
  options: {
    includeNonText: boolean;
    /** Tests only: a smaller LEFT_OUT_CAP. */
    leftOutCap?: number;
    /** Each file's raw git path (historyGitPaths); a file without one is judged on its file path alone. */
    gitPaths?: ReadonlyMap<FileNode, string>;
  } = { includeNonText: false }
): Promise<HistoryCopyResult> {
  const nonTextLimit = settings.maxNonTextFileSizeKB * 1024;
  const payloadFiles: PayloadFile[] = [];
  const nonTextFiles: { path: string; size: number }[] = [];
  let nonTextTotalBytes = 0, nonTextOverLimitCount = 0, excludedNonTextCount = 0;
  let copied = 0, skippedSize = 0, limitReached = false, limitLeftOut = 0, limitLeftOutCapped = false;
  const leftOutCap = options.leftOutCap ?? LEFT_OUT_CAP;
  const unresolved: string[] = [];
  let nonPortableCount = 0;
  const nonPortablePaths: string[] = [];

  const pathsOf = (f: FileNode) => {
    const absPath = (f.change.renameUri ?? f.change.uri).fsPath;
    const roots = workspaceRoots.length ? workspaceRoots : [f.repoRoot];
    const clipboardPath = toClipboardPathFromRoots(roots, absPath);
    const kept = !settings.useFilters ||
      fileMatchesFilters(clipboardPath, settings.filterRules, settings.useIncludeFilters, settings.useExcludeFilters, absPath);
    // A name the payload cannot carry: skipped and named, never read (decision X1). Judged
    // on the git path too (on Windows the file path has already turned a committed `\`
    // into a separator) and on the header as written (a root label is part of it).
    const unportable = kept
      ? nonPortableGitName(roots, f.repoRoot, options.gitPaths?.get(f) ?? '', absPath, clipboardPath)
      : undefined;
    return { absPath, clipboardPath, kept, unportable };
  };

  for (const [fileIndex, f] of files.entries()) {
    // Before the limit check: such a file is not a candidate, so it never trips the limit.
    const unportable = pathsOf(f).unportable;
    if (unportable !== undefined) {
      nonPortableCount++;
      if (nonPortablePaths.length < UNREADABLE_PATHS_KEPT) nonPortablePaths.push(unportable);
      continue;
    }
    if (settings.setMaxFileCount && copied >= settings.fileCountLimit) {
      limitReached = true;
      // What the limit left out (filters applied, nothing read), for the dialog and notice.
      // Counted up to the cap, then it stops: the number only has to say "a lot".
      for (let i = fileIndex; i < files.length; i++) {
        const p = pathsOf(files[i]);
        if (!p.kept || p.unportable !== undefined) continue;
        if (limitLeftOut >= leftOutCap) { limitLeftOutCapped = true; break; }
        limitLeftOut++;
      }
      break;
    }
    const { absPath, clipboardPath, kept } = pathsOf(f);
    if (!kept) continue;

    const content = await read(f);
    // Unreadable at that commit: left out of the payload, as
    // in IntelliJ, which then warns "N files could not be resolved"
    // (CopyGitFilesContentAction) instead of dropping them in silence.
    if (content === undefined) { unresolved.push(basename(absPath)); continue; }

    if ('nonText' in content) {
      if (!options.includeNonText) { excludedNonTextCount++; continue; }
      const size = content.nonText.length;
      if (size > nonTextLimit) {
        skippedSize++; nonTextOverLimitCount++;
        payloadFiles.push({ path: clipboardPath, changeType: f.changeType, skippedReason: `size exceeds limit (${size} bytes)` });
        continue;
      }
      payloadFiles.push({ path: clipboardPath, nonText: content.nonText, changeType: f.changeType });
      nonTextFiles.push({ path: clipboardPath, size });
      nonTextTotalBytes += size;
      copied++;
      continue;
    }

    const size = Buffer.byteLength(content.text, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedSize++; payloadFiles.push({ path: clipboardPath, changeType: f.changeType, skippedReason: `size exceeds limit (${size} bytes)` }); continue;
    }
    payloadFiles.push({ path: clipboardPath, content: content.text, changeType: f.changeType }); copied++;
  }

  // Same single-root rule as every other copy path — without it this entry's payload
  // carries no `// clipcode-root:` line and Paste & Restore cannot align folder levels.
  // Always the Git layout: IntelliJ copies every log/history selection through
  // GitClipboardPayloadBuilder.buildGitPayload, and so does the Graph copy here.
  // buildPayload added blank lines, so the same commit gave different bytes per tool.
  const payload = buildGitPayload({
    headerFormat: settings.headerFormat, preText: settings.preText, postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles, files: payloadFiles, sourceRoot: sourceRootName(workspaceRoots)
  });
  return {
    files: payloadFiles, payload, copiedFileCount: copied, skippedFileSizeCount: skippedSize, fileLimitReached: limitReached,
    unresolved, excludedNonTextCount, limitLeftOut, limitLeftOutCapped, nonTextFiles, nonTextTotalBytes, nonTextOverLimitCount,
    unreadOverLimitCount: 0, nonPortableCount, nonPortablePaths, estimatedBytes: Buffer.byteLength(payload, 'utf8')
  };
}

/**
 * What the History copy tells the user: a warning naming the files that could not be read
 * at their commit, and the completion notice — the same details (non-text carried or left
 * out, what the file-count limit left out) as every other Git copy surface.
 */
export function historyCopyNotice(
  result: HistoryCopyResult,
  settings: Pick<ClipCodeSettings, 'fileCountLimit'>
): { unresolvedWarning: string | undefined; message: string; emptyWarning: string } {
  const unresolvedWarning = result.unresolved.length > 0
    ? `${result.unresolved.length} files could not be resolved: ${result.unresolved.join(', ')}`
    : undefined;
  const s = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
  const l = result.fileLimitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
  // Unreadable files have their own warning above, so they are not repeated here.
  const details = copyNoticeDetails({ ...result, skippedUnreadableCount: 0, unreadablePaths: [] });
  // Nothing to copy: what was skipped by name (or left out) is said, not "no changes".
  const emptyWarning = gitNothingToCopyNotice(details, 'No Git changes found to copy.');
  return { unresolvedWarning, message: [`${result.copiedFileCount} Git file(s) copied${s}.${l}`, ...details].join(' '), emptyWarning };
}

/** `(repoRoot, from, to)` → the raw git paths that differ between two commits, or undefined when git could not be asked. */
export type ChangedPathLister = (repoRoot: string, from: string, to: string) => Promise<string[] | undefined>;

/**
 * Each History file's path as git stores it (`/`-separated), for the X1 portability check:
 * the Git extension hands History only a file path, and on Windows that has already turned
 * a `\` committed elsewhere into a separator (`a\b.png` reads `a/b.png`). One lister call
 * per commit and parent (the empty tree for a root commit); a file is matched to the raw
 * paths that spell its `/`-separated path, in order, so a real `a/b.png` beside `a\b.png`
 * each get their own. A file whose lister failed is left out (judged on its file path).
 */
export async function historyGitPaths(files: FileNode[], list: ChangedPathLister): Promise<Map<FileNode, string>> {
  const byCommit = new Map<string, FileNode[]>();
  for (const f of files) {
    const key = `${f.repoRoot}\u0000${f.commit.hash}`;
    (byCommit.get(key) ?? byCommit.set(key, []).get(key)!).push(f);
  }
  const result = new Map<FileNode, string>();
  for (const group of byCommit.values()) {
    const { repoRoot, commit } = group[0];
    const raw = new Set<string>();
    let listed = true;
    for (const parent of commit.parents.length > 0 ? commit.parents : [EMPTY_TREE]) {
      const paths = await list(repoRoot, parent, commit.hash);
      if (paths === undefined) { listed = false; break; }
      for (const p of paths) raw.add(p);
    }
    if (!listed) continue;
    const bySpelling = new Map<string, string[]>();
    for (const p of raw) {
      const key = p.replaceAll('\\', '/');
      (bySpelling.get(key) ?? bySpelling.set(key, []).get(key)!).push(p);
    }
    for (const f of group) {
      const match = bySpelling.get(f.relPath)?.shift();
      if (match !== undefined) result.set(f, match);
    }
  }
  return result;
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }
