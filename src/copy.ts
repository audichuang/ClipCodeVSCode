import path from 'node:path';
import { buildPayload, type PayloadFile } from './clipboardFormat.js';
import { mapInOrder } from './concurrency.js';
import { directoryExcluded, fileMatchesFilters } from './filterMatcher.js';
import { fileSize, listFilesRecursive, readClassifiedFile } from './fileSystem.js';
import { nonPortableName, sourceRootName, toClipboardPathFromRoots } from './pathResolver.js';
import type { ClipCodeSettings } from './settings.js';

/**
 * The four numbers the copy notification reports for a payload, in ONE linear pass.
 *
 * Byte-mirror of `ClipCode/.../TokenEstimator.kt stats`. All four are a function of
 * the whole clipboard text — headers, pre/post text and the `clipcode-root` line
 * included — because that is what actually gets pasted. They are NOT per-file sums:
 * carrying them per file is what let IntelliJ's old counters drift into numbers the
 * two tools never agreed on (they silently dropped every header and blank separator
 * line). Pinned by the shared golden `clipboard-contract.json` (`tokenCases`).
 *
 * - `chars`  UTF-16 code units, i.e. `String.length` on both sides. An astral char
 *            (emoji) counts 2 in Kotlin and 2 here — identical by construction.
 * - `lines`  `\n` count + 1, so a payload with no trailing newline still counts its
 *            last line. Empty text is 0 lines.
 * - `words`  maximal runs of non-separator characters.
 * - `tokens` `words` plus a point for each structural punctuation mark — a crude
 *            AI-payload size gauge, deliberately not a real tokenizer.
 *
 * The word scan separates on an ASCII whitespace class, NOT JS `\s`: Kotlin's `\s` is
 * ASCII-only, so a Unicode split would count U+3000 / NBSP-separated CJK text as
 * more words here than IntelliJ does and the two tools would disagree on the same
 * payload. Same reason `clipboardFormat.ts` pins ASCII_WS.
 *
 * One linear pass, O(1) extra memory: this blocks the single extension-host thread on
 * the whole payload, and materialising one string per word froze it precisely when the
 * numbers matter most (the 1M/2M-token warning).
 */
export interface PayloadStats {
  chars: number;
  lines: number;
  words: number;
  tokens: number;
}

export function payloadStats(text: string): PayloadStats {
  let words = 0;
  let punctuation = 0;
  let newlines = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0A) newlines++;
    // Space 0x20 plus the contiguous 0x09-0x0D block (\t \n \x0B \f \r) —
    // exactly the six ASCII separators, nothing Unicode.
    if (code === 0x20 || (code >= 0x09 && code <= 0x0D)) {
      inWord = false;
      continue;
    }
    // A maximal run of non-separators is one word — what split-then-drop-empty counted.
    if (!inWord) {
      inWord = true;
      words++;
    }
    // ; , ( ) { } [ ]
    if (
      code === 0x3B || code === 0x2C || code === 0x28 || code === 0x29 ||
      code === 0x7B || code === 0x7D || code === 0x5B || code === 0x5D
    ) {
      punctuation++;
    }
  }
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : newlines + 1,
    words,
    tokens: words + punctuation
  };
}

/** The `tokens` field alone. Kept because it is the name the contract fixtures use. */
export function estimateTokens(text: string): number {
  return payloadStats(text).tokens;
}

export interface CopyResult {
  files: PayloadFile[];
  payload: string;
  /** Entries carried with a body, text and (Include) non-text alike: what the file-count limit counts. */
  copiedFileCount: number;
  /** Size placeholders emitted (`// File skipped: size exceeds limit (...)`), whatever the kind. */
  skippedFileSizeCount: number;
  /** Could not be read: stat/read failure, a dangling symlink, a folder that cannot be listed. */
  skippedUnreadableCount: number;
  /** First UNREADABLE_PATHS_KEPT of those, as clipboard paths, for the notice. */
  unreadablePaths: string[];
  /** Symlinks to a folder, selected or met while expanding: never walked, skipped and named. */
  symlinkedFolderCount: number;
  /** First UNREADABLE_PATHS_KEPT of those, as clipboard paths (the link's own path). */
  symlinkedFolderPaths: string[];
  /**
   * Files and folders whose real name a payload header cannot carry (pathResolver
   * nonPortableName): never read, not counted toward the file-count limit; a folder costs
   * its whole subtree and is named once.
   */
  nonPortableCount: number;
  /** First UNREADABLE_PATHS_KEPT of those, with the real name (a `\` kept as typed). */
  nonPortablePaths: string[];
  /** Exclude only: non-text files within the text limit that were left out. */
  excludedNonTextCount: number;
  fileLimitReached: boolean;
  /** Candidates (after dedup and filters) the file-count limit cut off; none of them was read. */
  limitLeftOut: number;
  /** More than limitLeftOut were left out: the walk stopped counting at LEFT_OUT_CAP. */
  limitLeftOutCapped: boolean;
  /** Include only: the non-text entries carried as Base64, in payload order. */
  nonTextFiles: { path: string; size: number }[];
  nonTextTotalBytes: number;
  /** Include only: non-text files read but over maxNonTextFileSizeKB, copied as size placeholders. */
  nonTextOverLimitCount: number;
  /** Over both per-file limits: never read (kind unknown), copied as size placeholders. */
  unreadOverLimitCount: number;
  /** UTF-8 byte length of the payload. */
  estimatedBytes: number;
}

export interface CopyOptions {
  /**
   * Carry non-text files (NUL or not strict UTF-8) as Base64 entries. False is the
   * behaviour before non-text support, byte for byte: they are left out, and a file
   * over the text limit becomes a size placeholder without being read.
   */
  includeNonText: boolean;
  /** Tests only: a smaller LEFT_OUT_CAP. */
  leftOutCap?: number;
}

/**
 * How many candidates past the file-count limit the walk counts before it stops. Counting
 * every one walked the whole tree after the limit tripped — copying a repository root went
 * from 48 ms to 6.2 s, paid twice on Exclude — for a number that only has to say "a lot".
 * Past the cap the notice and dialog say `1000+`.
 */
export const LEFT_OUT_CAP = 1000;

/**
 * A left-out total as the Git surfaces report it: counted up to the cap, and flagged when
 * at least one more went past it (exactly the cap still reads "1000", the files copy's rule).
 */
export function capLeftOut(total: number, cap: number = LEFT_OUT_CAP): { limitLeftOut: number; limitLeftOutCapped: boolean } {
  return total > cap ? { limitLeftOut: cap, limitLeftOutCapped: true } : { limitLeftOut: total, limitLeftOutCapped: false };
}

interface CopyState {
  copiedFileCount: number;
  skippedFileSizeCount: number;
  skippedUnreadableCount: number;
  unreadablePaths: string[];
  symlinkedFolderCount: number;
  symlinkedFolderPaths: string[];
  nonPortableCount: number;
  nonPortablePaths: string[];
  excludedNonTextCount: number;
  fileLimitReached: boolean;
  limitLeftOut: number;
  limitLeftOutCapped: boolean;
  nonTextFiles: { path: string; size: number }[];
  nonTextTotalBytes: number;
  nonTextOverLimitCount: number;
  unreadOverLimitCount: number;
}

const READ_CONCURRENCY = 16;
export const UNREADABLE_PATHS_KEPT = 10;

export async function collectCopyFiles(
  workspaceRoots: string | string[],
  inputPaths: string[],
  settings: ClipCodeSettings,
  options: CopyOptions = { includeNonText: false }
): Promise<CopyResult> {
  const files: PayloadFile[] = [];
  const seen = new Set<string>();
  const state: CopyState = {
    copiedFileCount: 0,
    skippedFileSizeCount: 0,
    skippedUnreadableCount: 0,
    unreadablePaths: [],
    symlinkedFolderCount: 0,
    symlinkedFolderPaths: [],
    nonPortableCount: 0,
    nonPortablePaths: [],
    excludedNonTextCount: 0,
    fileLimitReached: false,
    limitLeftOut: 0,
    limitLeftOutCapped: false,
    nonTextFiles: [],
    nonTextTotalBytes: 0,
    nonTextOverLimitCount: 0,
    unreadOverLimitCount: 0
  };
  const roots = normalizeRoots(workspaceRoots);
  const textLimit = settings.maxFileSizeKB * 1024;
  const nonTextLimit = settings.maxNonTextFileSizeKB * 1024;
  // A file over every limit that could apply to it is not read: its kind does not matter.
  // Exclude keeps the old rule (only the text limit applies), so a large image is still a
  // size placeholder there, exactly as before.
  const readLimit = options.includeNonText ? Math.max(textLimit, nonTextLimit) : textLimit;
  const limitOn = settings.setMaxFileCount;
  const leftOutCap = options.leftOutCap ?? LEFT_OUT_CAP;
  // One more candidate past the limit: counted up to the cap, after which the walk stops.
  const leaveOut = (): void => {
    if (state.limitLeftOut >= leftOutCap) state.limitLeftOutCapped = true;
    else state.limitLeftOut++;
  };
  // A name the payload cannot carry: skipped and named. Past the file-count limit it is
  // as silent as an unreadable folder there (and, not being a candidate, not left out).
  const nonPortableSeen = new Set<string>();
  const noteNonPortable = (absolutePath: string, name: string): void => {
    // A folder selected and also inside a selected folder is named once.
    if (!state.fileLimitReached && !nonPortableSeen.has(absolutePath)) {
      nonPortableSeen.add(absolutePath);
      state.nonPortableCount++;
      if (state.nonPortablePaths.length < UNREADABLE_PATHS_KEPT) state.nonPortablePaths.push(name);
    }
  };
  const isNonPortable = (absolutePath: string, directory = false): boolean => {
    const name = nonPortableName(roots, absolutePath, { directory });
    if (name === undefined) return false;
    noteNonPortable(absolutePath, name);
    return true;
  };
  // A name that is not valid UTF-8 (the walker sees it lossily decoded, U+FFFD in place of
  // the bad bytes): not portable either, and not walked — a folder is named once.
  const onNonUtf8Name = (lossyPath: string): void => {
    const absolute = path.resolve(lossyPath);
    noteNonPortable(absolute, toClipboardPathFromRoots(roots, absolute));
  };
  const enterDirectory = (dirPath: string): boolean => {
    const absolute = path.resolve(dirPath);
    if (
      settings.useFilters && settings.useExcludeFilters &&
      directoryExcluded(toClipboardPathFromRoots(roots, absolute), settings.filterRules, absolute)
    ) {
      return false;
    }
    // A folder (or a symlinked one) with such a name costs its whole subtree, named once.
    return !isNonPortable(absolute, true);
  };
  const noteUnreadable = (absolutePath: string) => {
    state.skippedUnreadableCount++;
    if (state.unreadablePaths.length < UNREADABLE_PATHS_KEPT) {
      state.unreadablePaths.push(toClipboardPathFromRoots(roots, path.resolve(absolutePath)));
    }
  };
  // A link reached twice (selected and also inside a selected folder) is named once.
  const symlinkedFoldersSeen = new Set<string>();

  // Candidates buffered out of the ordered walk below; dedup and filtering happen
  // there (no I/O), so the candidate order is fixed before anything is read.
  const batch: { absolutePath: string; relativePath: string }[] = [];
  // Resolve one buffered batch concurrently, then apply limit/size/order bookkeeping
  // over the in-order results so the payload is byte-identical to the old serial
  // version. As with the git copy, tripping the limit mid-batch discards up to a
  // batch of already-issued reads (bounded over-fetch); the discarded tail is counted
  // in limitLeftOut.
  const drainBatch = async (): Promise<void> => {
    const pending = batch.splice(0);
    const read = mapInOrder(pending, READ_CONCURRENCY, async candidate => {
      // Stat first and read only what fits — the size guard exists to avoid pulling
      // a multi-GB file into memory.
      // Per-file catch: mapInOrder is Promise.all, so ONE EACCES or a dangling symlink
      // (which listFilesRecursive does yield) rejected out of collectCopyFiles and the
      // whole copy produced nothing at all. IntelliJ skips the file and copies the rest.
      try {
        const size = await fileSize(candidate.absolutePath);
        return { candidate, size, content: size > readLimit ? undefined : await readClassifiedFile(candidate.absolutePath) };
      } catch {
        return { candidate, size: 0, content: undefined, failed: true };
      }
    });
    for await (const result of read) {
      const { candidate, size, content } = result;
      if (state.fileLimitReached || (limitOn && state.copiedFileCount >= settings.fileCountLimit)) {
        state.fileLimitReached = true;
        leaveOut();
        continue;
      }
      if ('failed' in result) { noteUnreadable(candidate.absolutePath); continue; }
      if (content === undefined) {
        // size > readLimit: a size placeholder, the file never read.
        state.skippedFileSizeCount++;
        if (size > Math.max(textLimit, nonTextLimit)) state.unreadOverLimitCount++;
        files.push({ path: candidate.relativePath, skippedReason: `size exceeds limit (${size} bytes)` });
        continue;
      }
      if ('text' in content) {
        if (size > textLimit) {
          state.skippedFileSizeCount++;
          files.push({ path: candidate.relativePath, skippedReason: `size exceeds limit (${size} bytes)` });
          continue;
        }
        // A 0-byte file is text content: `!content` dropped every empty __init__.py /
        // .gitkeep, which IntelliJ copies (it checks `file.length == 0L` explicitly).
        files.push({ path: candidate.relativePath, content: content.text });
        state.copiedFileCount++;
        continue;
      }
      if (!options.includeNonText) { state.excludedNonTextCount++; continue; }
      if (size > nonTextLimit) {
        state.skippedFileSizeCount++;
        state.nonTextOverLimitCount++;
        files.push({ path: candidate.relativePath, skippedReason: `size exceeds limit (${size} bytes)` });
        continue;
      }
      files.push({ path: candidate.relativePath, nonText: content.nonText });
      state.nonTextFiles.push({ path: candidate.relativePath, size: content.nonText.length });
      state.nonTextTotalBytes += content.nonText.length;
      state.copiedFileCount++;
    }
  };

  walk: for (const inputPath of inputPaths) {
    const onUnreadable = (dirPath: string) => {
      // Past the limit nothing is read; an unreadable folder there is not reported.
      if (!state.fileLimitReached) noteUnreadable(dirPath);
    };
    const onSymlinkedFolder = (linkPath: string) => {
      // Same as an unreadable folder: past the limit it is not reported.
      if (state.fileLimitReached) return;
      const absolute = path.resolve(linkPath);
      if (symlinkedFoldersSeen.has(absolute)) return;
      symlinkedFoldersSeen.add(absolute);
      state.symlinkedFolderCount++;
      if (state.symlinkedFolderPaths.length < UNREADABLE_PATHS_KEPT) {
        state.symlinkedFolderPaths.push(toClipboardPathFromRoots(roots, absolute));
      }
    };
    for await (const filePath of listFilesRecursive(inputPath, enterDirectory, true, onUnreadable, onSymlinkedFolder, onNonUtf8Name)) {
      const absolutePath = path.resolve(filePath);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);

      const relativePath = toClipboardPathFromRoots(roots, absolutePath);
      if (
        settings.useFilters &&
        !fileMatchesFilters(
          relativePath,
          settings.filterRules,
          settings.useIncludeFilters,
          settings.useExcludeFilters,
          absolutePath
        )
      ) {
        continue;
      }
      // Not read and not a candidate: it never consumes the file-count limit.
      if (isNonPortable(absolutePath)) continue;

      // The limit check needs an exact copiedFileCount, so drain first whenever the
      // buffered candidates could still push the count up to the limit. Below that
      // watermark no batch can trip it, so the walk keeps buffering.
      if (!state.fileLimitReached && limitOn && state.copiedFileCount + batch.length >= settings.fileCountLimit) {
        await drainBatch();
        if (state.copiedFileCount >= settings.fileCountLimit) state.fileLimitReached = true;
      }
      // Once the limit has tripped the walk goes on (no reads) only to count what it left
      // out: every remaining candidate, size placeholders and unreadable files included,
      // because before the limit tripped they would all have been processed. It stops once
      // the count passes LEFT_OUT_CAP.
      if (state.fileLimitReached) {
        leaveOut();
        if (state.limitLeftOutCapped) break walk;
        continue;
      }

      batch.push({ absolutePath, relativePath });
      if (batch.length >= READ_CONCURRENCY) await drainBatch();
    }
  }
  await drainBatch();

  return buildCopyResult(files, state, settings, roots);
}

function buildCopyResult(
  files: PayloadFile[],
  state: CopyState,
  settings: ClipCodeSettings,
  roots: string[]
): CopyResult {
  const payload = buildPayload({
    headerFormat: settings.headerFormat,
    preText: settings.preText,
    postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
    files,
    // Only a single-root copy has an unambiguous source root; multi-root paths
    // carry per-root labels, so omit metadata there.
    sourceRoot: sourceRootName(roots)
  });
  return { files, payload, ...state, estimatedBytes: Buffer.byteLength(payload, 'utf8') };
}

function normalizeRoots(workspaceRoots: string | string[]): string[] {
  return Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
}
