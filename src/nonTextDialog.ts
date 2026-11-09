import { headerFormatUnescapable } from './clipboardFormat.js';
import { formatSize } from './restoreSummary.js';
import type { ClipCodeSettings } from './settings.js';

// User text for a files copy that found non-text files (spec non-text-files.md, "Asking the
// user"). Pure, so the numbers can be checked against the Include result in unit tests.
// Every number here is read off the Include result itself, never a parallel estimate.
// Shared by every copy surface: files and open editors (CopyResult), SCM changes, and the
// Graph / PR / History commit copies.

export type NonTextChoice = 'Include' | 'Exclude';

/** Paths listed in the dialog before "and N more". */
const DIALOG_PATHS = 10;
/** Unreadable / symlinked-folder / non-portable paths named in the completion notice and dialog. */
const NOTICE_PATHS = 3;
/** Display width a dialog path is shortened to. */
const PATH_WIDTH = 70;
const ELLIPSIS = '…';
/**
 * Decision X2: Include is left out when its payload would be over 50 MiB, the whole-payload
 * ceiling every implementation shares, so no Include payload is larger than what the others
 * accept. Exclude and text-only copies have no such limit.
 */
export const INCLUDE_PAYLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export interface NonTextDialogOptions {
  /** Overrides INCLUDE_PAYLOAD_LIMIT_BYTES (tests). */
  payloadLimitBytes?: number;
}

/** What the dialog reads off an Include result; every copy surface's result provides it. */
export interface NonTextSummary {
  /** The non-text entries carried as Base64, in payload order. */
  nonTextFiles: { path: string; size: number }[];
  nonTextTotalBytes: number;
  /** Non-text files read but over maxNonTextFileSizeKB, copied as size placeholders. */
  nonTextOverLimitCount: number;
  /** Over both per-file limits: never read (kind unknown), copied as size placeholders. */
  unreadOverLimitCount: number;
  /** Candidates the file-count limit cut off. */
  limitLeftOut: number;
  /** More than limitLeftOut were cut off (the files copy stops counting once its past-limit budget is spent). */
  limitLeftOutCapped?: boolean;
  /** UTF-8 byte length of the payload. */
  estimatedBytes: number;
  /** Files copy only: symlinked folders skipped (never followed) and their first paths. */
  symlinkedFolderCount?: number;
  symlinkedFolderPaths?: string[];
  /** Files and folders (Git copies: changed paths) skipped because a payload header cannot carry their real name. */
  nonPortableCount?: number;
  nonPortablePaths?: string[];
}

/** What the completion notice reads off the result that was copied. */
export interface NonTextNoticeCounts {
  nonTextFiles: { path: string; size: number }[];
  /** Exclude only: non-text files left out. */
  excludedNonTextCount: number;
  limitLeftOut: number;
  limitLeftOutCapped?: boolean;
  /** Unreadable items, non-text files left out NOT included. */
  skippedUnreadableCount: number;
  unreadablePaths: string[];
  /** Files copy only: symlinked folders skipped (never followed) and their first paths. */
  symlinkedFolderCount?: number;
  symlinkedFolderPaths?: string[];
  /** Files and folders (Git copies: changed paths) skipped because a payload header cannot carry their real name. */
  nonPortableCount?: number;
  nonPortablePaths?: string[];
  /**
   * With fileCountLimit: the copy reached the file-count limit. When no left-out number was
   * counted the notice says "File limit N reached." instead of a "0+" clause (X9).
   */
  fileLimitReached?: boolean;
  fileCountLimit?: number;
}

export interface NonTextDialog {
  message: string;
  detail: string;
  /** 'Include' first when offered; Cancel is the dialog's own close button (undefined). */
  buttons: NonTextChoice[];
}

export function nonTextDialog(
  include: NonTextSummary,
  settings: Pick<ClipCodeSettings, 'headerFormat'>,
  options: NonTextDialogOptions = {}
): NonTextDialog {
  const unescapable = headerFormatUnescapable(settings.headerFormat);
  // The estimate never reads below the raw total of the files it carries.
  const estimate = Math.max(include.estimatedBytes, include.nonTextTotalBytes);
  const overPayloadLimit = estimate > (options.payloadLimitBytes ?? INCLUDE_PAYLOAD_LIMIT_BYTES);
  const includeAllowed = !unescapable && !overPayloadLimit;
  const lines = [
    `Non-text files: ${include.nonTextFiles.length} (${formatSize(include.nonTextTotalBytes)})`,
    `Estimated payload with them: ${formatSize(estimate)}`
  ];
  for (const file of include.nonTextFiles.slice(0, DIALOG_PATHS)) {
    lines.push(`${shortenPath(file.path, PATH_WIDTH)}  ${formatSize(file.size)}`);
  }
  if (include.nonTextFiles.length > DIALOG_PATHS) {
    lines.push(`and ${include.nonTextFiles.length - DIALOG_PATHS} more`);
  }
  if (include.nonTextOverLimitCount > 0) {
    lines.push(`Over the non-text limit (not copied): ${include.nonTextOverLimitCount}`);
  }
  if (include.unreadOverLimitCount > 0) {
    lines.push(`Over both size limits (not read, copied as size placeholders): ${include.unreadOverLimitCount}`);
  }
  if (include.limitLeftOut > 0) {
    lines.push(`Left out by the file-count limit: ${leftOutText(include)}`);
  }
  if (include.symlinkedFolderCount) {
    lines.push(namedCount('Symlinked folder', include.symlinkedFolderCount, include.symlinkedFolderPaths ?? []));
  }
  if (include.nonPortableCount) {
    lines.push(namedCount('Name not portable', include.nonPortableCount, include.nonPortablePaths ?? []));
  }
  if (overPayloadLimit) {
    // A VS Code modal cannot disable a button (X26): Include is left out and Exclude is the default.
    lines.push(
      'Include is unavailable: the payload would be more than 50 MiB ' +
      `(non-text files: ${formatSize(include.nonTextTotalBytes)}).`
    );
  }
  if (unescapable) {
    lines.push(
      `Include is unavailable: the header format "${settings.headerFormat}" cannot be escaped, ` +
      'so Base64 lines would read as file headers.'
    );
  }
  return {
    message: includeAllowed
      ? 'The selection has non-text files. Include them as Base64?'
      : 'The selection has non-text files. They can only be left out.',
    detail: lines.join('\n'),
    buttons: includeAllowed ? ['Include', 'Exclude'] : ['Exclude']
  };
}

/**
 * The parts of the completion notice that are about what did NOT go in as text, each a
 * sentence. Never says "binary" or "non-UTF-8" (spec: "non-text file").
 */
export function copyNoticeDetails(result: NonTextNoticeCounts): string[] {
  const parts: string[] = [];
  if (result.nonTextFiles.length > 0) parts.push(`Non-text files copied as Base64: ${result.nonTextFiles.length}.`);
  if (result.excludedNonTextCount > 0) parts.push(`Non-text files left out: ${result.excludedNonTextCount}.`);
  if (result.limitLeftOut > 0) parts.push(`Left out by the file-count limit: ${leftOutText(result)}.`);
  else if (result.fileCountLimit !== undefined && (result.fileLimitReached || result.limitLeftOutCapped)) {
    parts.push(`File limit ${result.fileCountLimit} reached.`);
  }
  if (result.skippedUnreadableCount > 0) {
    parts.push(`${namedCount('Unreadable', result.skippedUnreadableCount, result.unreadablePaths)}.`);
  }
  if (result.symlinkedFolderCount) {
    parts.push(`${namedCount('Symlinked folder', result.symlinkedFolderCount, result.symlinkedFolderPaths ?? [])}.`);
  }
  if (result.nonPortableCount) {
    parts.push(`${namedCount('Name not portable', result.nonPortableCount, result.nonPortablePaths ?? [])}.`);
  }
  return parts;
}

/**
 * Decision X3: a files copy whose payload would carry no file (everything selected was
 * skipped, filtered or left out, or all that is left is size placeholders) must not write
 * the clipboard. Returns the warning to show in that case — "Nothing to copy." followed by
 * the skipped categories, the same sentences as the completion notice, plus the files over
 * the size limit — or undefined when there is something to write. One carried file (text or
 * Base64) is something to write, placeholders and all.
 */
export function nothingToCopyNotice(
  result: NonTextNoticeCounts & { files: readonly { path: string; skippedReason?: string }[] }
): string | undefined {
  if (result.files.some(file => !file.skippedReason)) return undefined;
  const parts = ['Nothing to copy.', ...copyNoticeDetails(result)];
  if (result.files.length > 0) {
    parts.push(`${namedCount('Over the size limit', result.files.length, result.files.map(file => file.path))}.`);
  }
  return parts.join(' ');
}

/**
 * The Git surfaces' warning when nothing is left to copy (spec case 29 → case 30): what was
 * skipped is named after "Nothing to copy.", the files copy's wording. With nothing skipped
 * either, the surface's own plain message (there were no changes to copy).
 */
export function gitNothingToCopyNotice(details: readonly string[], noChanges: string): string {
  return details.length > 0 ? ['Nothing to copy.', ...details].join(' ') : noChanges;
}

/**
 * The one "carries no file" rule of every Git surface (SCM, Graph, History): no copied file
 * and no size placeholder. "Unable to read" markers do not count — a payload of nothing but
 * markers overwrote the clipboard with "0 Git file(s) copied". Returns the warning to show
 * instead of writing the clipboard, or undefined when there is something to write.
 */
export function gitCopyNothingToCopy(
  result: { copiedFileCount: number; skippedFileSizeCount: number },
  details: readonly string[],
  noChanges: string
): string | undefined {
  if (result.copiedFileCount > 0 || result.skippedFileSizeCount > 0) return undefined;
  return gitNothingToCopyNotice(details, noChanges);
}

/** `Label: n (a, b, c and N more)` — the first NOTICE_PATHS paths, or just `Label: n` with none. */
function namedCount(label: string, count: number, paths: string[]): string {
  const named = paths.slice(0, NOTICE_PATHS);
  const more = count - named.length;
  const list = named.join(', ') + (more > 0 ? ` and ${more} more` : '');
  return list ? `${label}: ${count} (${list})` : `${label}: ${count}`;
}

/** `1000+` once the count stopped at its cap. */
function leftOutText(result: { limitLeftOut: number; limitLeftOutCapped?: boolean }): string {
  return `${result.limitLeftOut}${result.limitLeftOutCapped ? '+' : ''}`;
}

/** `vscode.window.showWarningMessage` with the dialog's buttons; injected so this stays pure. */
export type ShowNonTextDialog = (
  message: string,
  options: { modal: true; detail: string },
  ...buttons: NonTextChoice[]
) => PromiseLike<NonTextChoice | undefined>;

/**
 * Runs the Include copy and, when it carries at least one non-text file, asks whether to
 * keep them (Include), leave them out (Exclude: `run(false)`, the payload as before
 * non-text support) or copy nothing (Cancel / Esc → undefined). A copy without non-text
 * files never asks. The one decision flow every copy surface goes through.
 */
export async function askAboutNonText<T extends NonTextSummary>(
  settings: Pick<ClipCodeSettings, 'headerFormat'>,
  run: (includeNonText: boolean) => Promise<T>,
  show: ShowNonTextDialog,
  options: NonTextDialogOptions = {}
): Promise<T | undefined> {
  const include = await run(true);
  if (include.nonTextFiles.length === 0) return include;
  const dialog = nonTextDialog(include, settings, options);
  const choice = await show(dialog.message, { modal: true, detail: dialog.detail }, ...dialog.buttons);
  if (choice === 'Include' && dialog.buttons.includes('Include')) return include;
  if (choice === 'Exclude') return run(false);
  return undefined;
}

function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment);
}

/**
 * Shortens a `/`-separated path to at most [width] characters (grapheme clusters) so
 * the file name stays visible: the folder part shrinks first, down to its first segment
 * and an ellipsis; only then is the file name shortened in the middle, keeping its
 * extension. Cuts fall between whole characters and the ellipsis sits directly against
 * the text after it.
 */
export function shortenPath(filePath: string, width = PATH_WIDTH): string {
  const all = graphemes(filePath);
  if (all.length <= width) return filePath;
  const slash = filePath.lastIndexOf('/');
  const name = graphemes(slash === -1 ? filePath : filePath.slice(slash + 1));
  const folder = slash === -1 ? [] : graphemes(filePath.slice(0, slash));

  if (folder.length > 0) {
    // Room for the folder part, the '/' and the whole name.
    const folderRoom = width - name.length - 1;
    const firstSegment = graphemes(filePath.slice(0, filePath.indexOf('/')));
    if (folderRoom >= Math.min(firstSegment.length, folder.length) + 1) {
      return folder.slice(0, folderRoom - 1).join('') + ELLIPSIS + '/' + name.join('');
    }
    // The name needs more room: the folder part is its first segment (itself cut short
    // when it is long) and an ellipsis.
    const kept = firstSegment.slice(0, Math.max(1, Math.min(firstSegment.length, Math.floor(width / 4))));
    const prefix = kept.join('') + ELLIPSIS + '/';
    return prefix + shortenName(name, width - kept.length - 2);
  }
  return shortenName(name, width);
}

/** A file name cut in the middle to [width] characters, its extension kept. */
function shortenName(name: string[], width: number): string {
  if (name.length <= width) return name.join('');
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.length - dot : 0;
  const room = Math.max(2, width - 1);
  const tail = Math.min(name.length - 1, Math.max(extension, Math.floor(room / 2)));
  const head = Math.max(1, room - tail);
  return name.slice(0, head).join('') + ELLIPSIS + name.slice(name.length - tail).join('');
}
