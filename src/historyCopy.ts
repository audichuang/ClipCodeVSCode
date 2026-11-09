import { buildGitPayload, type PayloadFile } from './clipboardFormat.js';
import type { FileContent } from './fileSystem.js';
import { fileMatchesFilters } from './filterMatcher.js';
import type { FileNode } from './historyTree.js';
import { copyNoticeDetails, type NonTextSummary } from './nonTextDialog.js';
import { sourceRootName, toClipboardPathFromRoots } from './pathResolver.js';
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
  options: { includeNonText: boolean } = { includeNonText: false }
): Promise<HistoryCopyResult> {
  const nonTextLimit = settings.maxNonTextFileSizeKB * 1024;
  const payloadFiles: PayloadFile[] = [];
  const nonTextFiles: { path: string; size: number }[] = [];
  let nonTextTotalBytes = 0, nonTextOverLimitCount = 0, excludedNonTextCount = 0;
  let copied = 0, skippedSize = 0, limitReached = false, limitLeftOut = 0;
  const unresolved: string[] = [];

  const pathsOf = (f: FileNode) => {
    const absPath = (f.change.renameUri ?? f.change.uri).fsPath;
    const clipboardPath = toClipboardPathFromRoots(workspaceRoots.length ? workspaceRoots : [f.repoRoot], absPath);
    const kept = !settings.useFilters ||
      fileMatchesFilters(clipboardPath, settings.filterRules, settings.useIncludeFilters, settings.useExcludeFilters, absPath);
    return { absPath, clipboardPath, kept };
  };

  for (const f of files) {
    if (settings.setMaxFileCount && copied >= settings.fileCountLimit) {
      limitReached = true;
      // What the limit left out (filters applied, nothing read), for the dialog and notice.
      limitLeftOut = files.slice(files.indexOf(f)).filter(rest => pathsOf(rest).kept).length;
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
    unresolved, excludedNonTextCount, limitLeftOut, nonTextFiles, nonTextTotalBytes, nonTextOverLimitCount,
    unreadOverLimitCount: 0, estimatedBytes: Buffer.byteLength(payload, 'utf8')
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
): { unresolvedWarning: string | undefined; message: string } {
  const unresolvedWarning = result.unresolved.length > 0
    ? `${result.unresolved.length} files could not be resolved: ${result.unresolved.join(', ')}`
    : undefined;
  const s = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
  const l = result.fileLimitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
  // Unreadable files have their own warning above, so they are not repeated here.
  const details = copyNoticeDetails({ ...result, skippedUnreadableCount: 0, unreadablePaths: [] });
  return { unresolvedWarning, message: [`${result.copiedFileCount} Git file(s) copied${s}.${l}`, ...details].join(' ') };
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }
