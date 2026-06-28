import type { PayloadFile } from './clipboardFormat.js';
import { buildGitPayload } from './clipboardFormat.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';
import { readRefContent, type ContentRepo } from './gitContent.js';

export interface GraphCopyFile {
  repoRootFsPath: string;
  relativePath: string;
  oldRelativePath?: string;
  status: string; // canonical 'A'|'M'|'D'|'R'|'C' per spec §5.0;容忍 'R100'/'C75'
}

export interface GraphCopyPayload {
  hash: string;
  files: GraphCopyFile[];
}

export interface GraphCopySettings {
  headerFormat: string;
  preText: string;
  postText: string;
  addExtraLineBetweenFiles: boolean;
  maxFileSizeKB: number;
  fileCountLimit: number;
  setMaxFileCount: boolean;
}

export interface GraphCopyDeps {
  resolveRepo(repoRootFsPath: string): ContentRepo | undefined;
  settings: GraphCopySettings;
}

export interface GraphCopyResult {
  text: string;
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
  missingRepoCount: number;
}

function joinFsPath(root: string, relativePath: string): string {
  return `${root.replace(/[/\\]+$/, '')}/${relativePath}`;
}

export async function buildGraphCopyPayload(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload
): Promise<GraphCopyResult> {
  const { settings } = deps;
  const files: PayloadFile[] = [];
  let copiedFileCount = 0;
  let skippedFileSizeCount = 0;
  let missingRepoCount = 0;
  let fileLimitReached = false;

  for (const file of payload.files) {
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }

    // §5.0:R/C 帶相似度時截到字首後再對應
    const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
    const clipboardPath = file.relativePath;

    if (changeType === 'DELETED') {
      files.push({ path: clipboardPath, content: DELETED_FILE_MARKER, changeType });
      copiedFileCount++;
      continue;
    }

    const repo = deps.resolveRepo(file.repoRootFsPath);
    if (!repo) {
      missingRepoCount++;
      continue;
    }

    const absolutePath = joinFsPath(file.repoRootFsPath, file.relativePath);
    const content = await readRefContent(repo, payload.hash, absolutePath);
    if (content === undefined) continue; // 二進位/讀取失敗 → 跳過

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedFileSizeCount++;
      files.push({ path: clipboardPath, changeType, skippedReason: `size exceeds limit (${size} bytes)` });
      continue;
    }

    files.push({ path: clipboardPath, content, changeType });
    copiedFileCount++;
  }

  const text = buildGitPayload({
    headerFormat: settings.headerFormat,
    preText: settings.preText,
    postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
    files
  });

  return { text, copiedFileCount, skippedFileSizeCount, fileLimitReached, missingRepoCount };
}
