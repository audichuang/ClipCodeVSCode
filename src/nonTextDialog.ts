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
/** Unreadable / symlinked-folder paths named in the completion notice and dialog. */
const NOTICE_PATHS = 3;
/** Display width a dialog path is shortened to. */
const PATH_WIDTH = 70;
const ELLIPSIS = '…';

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
  /** More than limitLeftOut were cut off (the files copy stops counting at LEFT_OUT_CAP). */
  limitLeftOutCapped?: boolean;
  /** UTF-8 byte length of the payload. */
  estimatedBytes: number;
  /** Files copy only: symlinked folders skipped (never followed) and their first paths. */
  symlinkedFolderCount?: number;
  symlinkedFolderPaths?: string[];
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
}

export interface NonTextDialog {
  message: string;
  detail: string;
  /** 'Include' first when offered; Cancel is the dialog's own close button (undefined). */
  buttons: NonTextChoice[];
}

export function nonTextDialog(include: NonTextSummary, settings: Pick<ClipCodeSettings, 'headerFormat'>): NonTextDialog {
  const includeAllowed = !headerFormatUnescapable(settings.headerFormat);
  const lines = [
    `Non-text files: ${include.nonTextFiles.length} (${formatSize(include.nonTextTotalBytes)})`,
    `Estimated payload with them: ${formatSize(include.estimatedBytes)}`
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
  if (!includeAllowed) {
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
  if (result.skippedUnreadableCount > 0) {
    parts.push(`${namedCount('Unreadable', result.skippedUnreadableCount, result.unreadablePaths)}.`);
  }
  if (result.symlinkedFolderCount) {
    parts.push(`${namedCount('Symlinked folder', result.symlinkedFolderCount, result.symlinkedFolderPaths ?? [])}.`);
  }
  return parts;
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
  show: ShowNonTextDialog
): Promise<T | undefined> {
  const include = await run(true);
  if (include.nonTextFiles.length === 0) return include;
  const dialog = nonTextDialog(include, settings);
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
