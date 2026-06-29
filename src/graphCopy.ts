import type { ChangeTypeLabel, PayloadFile } from './clipboardFormat.js';
import { buildGitPayload } from './clipboardFormat.js';
import { mapInOrder } from './concurrency.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';
import { readRefContent, type ContentRepo } from './gitContent.js';

// Each file's content comes from one `git show` subprocess; fan them out so a
// large selection doesn't run them strictly one-at-a-time.
const READ_CONCURRENCY = 16;

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

// Sentinel hash for the working-tree (uncommitted) view: there is no commit to
// `git show`, so content is read from disk via deps.readWorking instead.
export const UNCOMMITTED_HASH = 'UNCOMMITTED';

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
  // Reads working-tree content for the UNCOMMITTED view (absolute fsPath).
  // Optional: commit-mode callers (a real hash) never need it.
  readWorking?(absolutePath: string): Promise<string | undefined>;
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

interface PreparedFile {
  clipboardPath: string;
  changeType: ChangeTypeLabel;
  kind: 'deleted' | 'missing' | 'content';
  content?: string;
}

// Per-file resolution with no shared state — safe to run concurrently. The slow
// `git show` (or working-tree read) lives here; the caller does the ordered,
// stateful bookkeeping over the results.
async function prepareFile(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload,
  file: GraphCopyFile
): Promise<PreparedFile> {
  // §5.0:R/C 帶相似度時截到字首後再對應
  const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
  const clipboardPath = file.relativePath;

  if (changeType === 'DELETED') {
    return { clipboardPath, changeType, kind: 'deleted' };
  }

  const repo = deps.resolveRepo(file.repoRootFsPath);
  if (!repo) {
    return { clipboardPath, changeType, kind: 'missing' };
  }

  const absolutePath = joinFsPath(file.repoRootFsPath, file.relativePath);
  const content = payload.hash === UNCOMMITTED_HASH && deps.readWorking
    ? await deps.readWorking(absolutePath)            // working-tree (uncommitted) view
    : await readRefContent(repo, payload.hash, absolutePath); // `git show <hash>:<path>`
  return { clipboardPath, changeType, kind: 'content', content };
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

  // Resolve each file's content concurrently (the slow `git show` per file),
  // then apply the limit/size/order bookkeeping sequentially over the in-order
  // results so the payload is byte-identical to the old serial version.
  // ponytail: when the file-count limit trips mid-batch, up to READ_CONCURRENCY-1
  // extra reads were already issued and are discarded — bounded over-fetch in
  // exchange for not serializing the common no-limit case.
  const prepared = mapInOrder(payload.files, READ_CONCURRENCY, file => prepareFile(deps, payload, file));
  for await (const file of prepared) {
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }

    if (file.kind === 'deleted') {
      files.push({ path: file.clipboardPath, content: DELETED_FILE_MARKER, changeType: file.changeType });
      copiedFileCount++;
      continue;
    }

    if (file.kind === 'missing') {
      missingRepoCount++;
      continue;
    }

    const content = file.content;
    if (content === undefined) continue; // 二進位/讀取失敗 → 跳過

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedFileSizeCount++;
      files.push({ path: file.clipboardPath, changeType: file.changeType, skippedReason: `size exceeds limit (${size} bytes)` });
      continue;
    }

    files.push({ path: file.clipboardPath, content, changeType: file.changeType });
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
