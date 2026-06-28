import path from 'node:path';
import { buildPayload, type PayloadFile } from './clipboardFormat.js';
import { fileMatchesFilters } from './filterMatcher.js';
import { fileSize, listFilesRecursive, readTextFile } from './fileSystem.js';
import { toClipboardPathFromRoots } from './pathResolver.js';
import type { ClipCodeSettings } from './settings.js';

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

  inputLoop:
  for (const inputPath of inputPaths) {
    for await (const filePath of listFilesRecursive(inputPath)) {
      const absolutePath = path.resolve(filePath);
      const shouldContinue = await appendCopyCandidate({
        roots,
        absolutePath,
        files,
        seen,
        settings,
        state,
        sizeBytes: () => fileSize(absolutePath),
        content: () => readTextFile(absolutePath)
      });
      if (!shouldContinue) break inputLoop;
    }
  }

  return buildCopyResult(files, state, settings);
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

  return buildCopyResult(files, state, settings);
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
  settings: ClipCodeSettings
): CopyResult {
  return {
    files,
    payload: buildPayload({
      headerFormat: settings.headerFormat,
      preText: settings.preText,
      postText: settings.postText,
      addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
      files
    }),
    copiedFileCount: state.copiedFileCount,
    skippedFileSizeCount: state.skippedFileSizeCount,
    fileLimitReached: state.fileLimitReached
  };
}

function normalizeRoots(workspaceRoots: string | string[]): string[] {
  return Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
}
