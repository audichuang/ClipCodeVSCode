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
  // Reads many committed blobs at a hash in ONE `git cat-file --batch` process,
  // bypassing the vscode.git per-repo operation queue that throttles N concurrent
  // show() calls. Returns relativePath -> content (undefined for missing/binary).
  // Optional: when absent (or on spawn failure) the per-file reader is used.
  readBatch?(repoRootFsPath: string, hash: string, relativePaths: string[]): Promise<Map<string, string | undefined>>;
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

function batchKey(repoRootFsPath: string, relativePath: string): string {
  return `${repoRootFsPath}\n${relativePath}`;
}

// Prefetch all committed blob contents up front with one `git cat-file --batch`
// per repo (parallel across repos). For the uncommitted view or when no readBatch
// is provided this returns an empty map and prepareFile falls back to per-file reads.
async function prefetchBatch(deps: GraphCopyDeps, payload: GraphCopyPayload): Promise<Map<string, string | undefined>> {
  const lookup = new Map<string, string | undefined>();
  if (payload.hash === UNCOMMITTED_HASH || !deps.readBatch) return lookup;

  const byRepo = new Map<string, string[]>();
  for (const file of payload.files) {
    const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
    if (changeType === 'DELETED' || !deps.resolveRepo(file.repoRootFsPath)) continue;
    (byRepo.get(file.repoRootFsPath) ?? byRepo.set(file.repoRootFsPath, []).get(file.repoRootFsPath)!).push(file.relativePath);
  }

  await Promise.all([...byRepo].map(async ([root, paths]) => {
    const contents = await deps.readBatch!(root, payload.hash, paths).catch(() => new Map<string, string | undefined>());
    for (const [path, content] of contents) lookup.set(batchKey(root, path), content);
  }));
  return lookup;
}

// Per-file resolution with no shared state — safe to run concurrently. Committed
// content comes from the prefetched batch; only the uncommitted view or a batch
// miss (spawn failure) falls back to a per-file read. The caller does the ordered,
// stateful bookkeeping over the results.
async function prepareFile(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload,
  file: GraphCopyFile,
  batch: Map<string, string | undefined>
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
  const key = batchKey(file.repoRootFsPath, file.relativePath);
  let content: string | undefined;
  if (payload.hash === UNCOMMITTED_HASH && deps.readWorking) {
    content = await deps.readWorking(absolutePath);            // working-tree (uncommitted) view
  } else if (batch.has(key)) {
    content = batch.get(key);                                  // resolved by the single cat-file batch
  } else {
    content = await readRefContent(repo, payload.hash, absolutePath); // fallback: `git show <hash>:<path>`
  }
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

  // Fetch every committed blob in one `git cat-file --batch` per repo, then apply
  // the limit/size/order bookkeeping sequentially over the in-order results so the
  // payload is byte-identical to the old per-file version. mapInOrder still bounds
  // the rare fallback (uncommitted reads / batch spawn failure) concurrency.
  // ponytail: when the file-count limit trips mid-batch, the cat-file already read
  // every blob (cheap) — only fallback per-file reads are wasted, bounded to one
  // READ_CONCURRENCY window.
  const batch = await prefetchBatch(deps, payload);
  const prepared = mapInOrder(payload.files, READ_CONCURRENCY, file => prepareFile(deps, payload, file, batch));
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
