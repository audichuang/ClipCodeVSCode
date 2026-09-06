import path from 'node:path';
import { buildPayload, type PayloadFile } from './clipboardFormat.js';
import { mapInOrder } from './concurrency.js';
import { directoryExcluded, fileMatchesFilters } from './filterMatcher.js';
import { fileSize, listFilesRecursive, readTextFile } from './fileSystem.js';
import { toClipboardPathFromRoots } from './pathResolver.js';
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
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
}

export interface CopyTextFile {
  absolutePath: string;
  content: string;
  sizeBytes?: number;
}

interface CopyState {
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
}

const READ_CONCURRENCY = 16;

export async function collectCopyFiles(
  workspaceRoots: string | string[],
  inputPaths: string[],
  settings: ClipCodeSettings
): Promise<CopyResult> {
  const files: PayloadFile[] = [];
  const seen = new Set<string>();
  const state: CopyState = {
    copiedFileCount: 0,
    skippedFileSizeCount: 0,
    fileLimitReached: false
  };
  const roots = normalizeRoots(workspaceRoots);
  const pruneExcludedDirectory = (dirPath: string): boolean => {
    if (!settings.useFilters || !settings.useExcludeFilters) return true;
    const absolute = path.resolve(dirPath);
    return !directoryExcluded(toClipboardPathFromRoots(roots, absolute), settings.filterRules, absolute);
  };

  // Candidates buffered out of the ordered walk below; dedup and filtering happen
  // there (no I/O), so the candidate order is fixed before anything is read.
  const batch: { absolutePath: string; relativePath: string }[] = [];
  // Resolve one buffered batch concurrently, then apply limit/size/order bookkeeping
  // over the in-order results so the payload is byte-identical to the old serial
  // version. As with the git copy, tripping the limit mid-batch discards up to a
  // batch of already-issued reads (bounded over-fetch). False = stop the walk.
  const drainBatch = async (): Promise<boolean> => {
    const pending = batch.splice(0);
    const sizeLimit = settings.maxFileSizeKB * 1024;
    const read = mapInOrder(pending, READ_CONCURRENCY, async candidate => {
      // Stat first and read only what fits — the size guard exists to avoid pulling
      // a multi-GB file into memory.
      const size = await fileSize(candidate.absolutePath);
      return { candidate, size, content: size > sizeLimit ? undefined : await readTextFile(candidate.absolutePath) };
    });
    for await (const { candidate, size, content } of read) {
      if (settings.setMaxFileCount && state.copiedFileCount >= settings.fileCountLimit) {
        state.fileLimitReached = true;
        return false;
      }
      if (size > sizeLimit) {
        state.skippedFileSizeCount++;
        files.push({ path: candidate.relativePath, skippedReason: `size exceeds limit (${size} bytes)` });
        continue;
      }
      if (!content) continue;
      files.push({ path: candidate.relativePath, content });
      state.copiedFileCount++;
    }
    return true;
  };

  inputLoop:
  for (const inputPath of inputPaths) {
    for await (const filePath of listFilesRecursive(inputPath, pruneExcludedDirectory)) {
      // The limit check needs an exact copiedFileCount, so drain first whenever the
      // buffered candidates could still push the count up to the limit. Below that
      // watermark no batch can trip it, so the walk keeps buffering.
      if (settings.setMaxFileCount && state.copiedFileCount + batch.length >= settings.fileCountLimit) {
        if (!(await drainBatch())) break inputLoop;
        if (state.copiedFileCount >= settings.fileCountLimit) {
          state.fileLimitReached = true;
          break inputLoop;
        }
      }

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

      batch.push({ absolutePath, relativePath });
      if (batch.length >= READ_CONCURRENCY && !(await drainBatch())) break inputLoop;
    }
  }
  await drainBatch();

  return buildCopyResult(files, state, settings, roots);
}

export async function collectCopyTextFiles(
  workspaceRoots: string | string[],
  inputFiles: CopyTextFile[],
  settings: ClipCodeSettings
): Promise<CopyResult> {
  const files: PayloadFile[] = [];
  const seen = new Set<string>();
  const state: CopyState = {
    copiedFileCount: 0,
    skippedFileSizeCount: 0,
    fileLimitReached: false
  };
  const roots = normalizeRoots(workspaceRoots);

  for (const inputFile of inputFiles) {
    const shouldContinue = await appendCopyCandidate({
      roots,
      absolutePath: path.resolve(inputFile.absolutePath),
      files,
      seen,
      settings,
      state,
      sizeBytes: () => inputFile.sizeBytes ?? Buffer.byteLength(inputFile.content, 'utf8'),
      content: () => inputFile.content
    });
    if (!shouldContinue) break;
  }

  return buildCopyResult(files, state, settings, roots);
}

async function appendCopyCandidate(options: {
  roots: string[];
  absolutePath: string;
  files: PayloadFile[];
  seen: Set<string>;
  settings: ClipCodeSettings;
  state: CopyState;
  sizeBytes: () => number | Promise<number>;
  content: () => string | undefined | Promise<string | undefined>;
}): Promise<boolean> {
  if (
    options.settings.setMaxFileCount &&
    options.state.copiedFileCount >= options.settings.fileCountLimit
  ) {
    options.state.fileLimitReached = true;
    return false;
  }

  if (options.seen.has(options.absolutePath)) return true;
  options.seen.add(options.absolutePath);

  const relativePath = toClipboardPathFromRoots(options.roots, options.absolutePath);
  if (
    options.settings.useFilters &&
    !fileMatchesFilters(
      relativePath,
      options.settings.filterRules,
      options.settings.useIncludeFilters,
      options.settings.useExcludeFilters,
      options.absolutePath
    )
  ) {
    return true;
  }

  const size = await options.sizeBytes();
  if (size > options.settings.maxFileSizeKB * 1024) {
    options.state.skippedFileSizeCount++;
    options.files.push({ path: relativePath, skippedReason: `size exceeds limit (${size} bytes)` });
    return true;
  }

  const content = await options.content();
  if (!content) return true;

  options.files.push({ path: relativePath, content });
  options.state.copiedFileCount++;
  return true;
}

function buildCopyResult(
  files: PayloadFile[],
  state: CopyState,
  settings: ClipCodeSettings,
  roots: string[]
): CopyResult {
  return {
    files,
    payload: buildPayload({
      headerFormat: settings.headerFormat,
      preText: settings.preText,
      postText: settings.postText,
      addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
      files,
      // Only a single-root copy has an unambiguous source root; multi-root paths
      // carry per-root labels, so omit metadata there.
      sourceRoot: roots.length === 1 ? path.basename(roots[0]) : undefined
    }),
    copiedFileCount: state.copiedFileCount,
    skippedFileSizeCount: state.skippedFileSizeCount,
    fileLimitReached: state.fileLimitReached
  };
}

function normalizeRoots(workspaceRoots: string | string[]): string[] {
  return Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
}
