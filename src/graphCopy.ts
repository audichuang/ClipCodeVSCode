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
  // The files dropped for exceeding maxFileSizeKB, so the caller can list them
  // instead of only showing a count.
  skippedFiles: Array<{ path: string; bytes: number }>;
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

function baseNameOf(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
}

// The repo folder name shared by every file, or undefined if they span repos.
function singleRepoRoot(files: GraphCopyFile[]): string | undefined {
  const roots = new Set(files.map(f => f.repoRootFsPath));
  return roots.size === 1 ? baseNameOf([...roots][0]) : undefined;
}

// Prefetch committed blob contents up front with one `git cat-file --batch` per
// repo (parallel across repos). For the uncommitted view or when no readBatch is
// provided this returns an empty map and prepareFile falls back to per-file reads.
async function prefetchBatch(deps: GraphCopyDeps, payload: GraphCopyPayload): Promise<Map<string, string | undefined>> {
  const lookup = new Map<string, string | undefined>();
  if (payload.hash === UNCOMMITTED_HASH || !deps.readBatch) return lookup;
  const { settings } = deps;

  const byRepo = new Map<string, string[]>();
  let requested = 0;
  for (const file of payload.files) {
    // Don't batch past the file-count limit — the bookkeeping loop would discard
    // the rest anyway, so reading them would be wasted work/memory. (Files dropped
    // here just fall back to a per-file read if the limit math later needs them.)
    if (settings.setMaxFileCount && requested >= settings.fileCountLimit) break;
    const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
    // The batch reads via `git -C <root> cat-file` directly, so it does NOT need
    // a matching vscode.git repo. Don't gate on resolveRepo here — the graph
    // already proved <root> is a real repo by showing its commits, and requiring
    // an exact path match against vscode.git's discovery fails on SSH/symlink/
    // case differences (→ "No source copied" even though the files exist).
    if (changeType === 'DELETED') continue;
    // `cat-file --batch` is newline-delimited, so a path containing a line break
    // would corrupt request/response alignment — route those to the per-file reader.
    if (file.relativePath.includes('\n') || file.relativePath.includes('\r')) continue;
    (byRepo.get(file.repoRootFsPath) ?? byRepo.set(file.repoRootFsPath, []).get(file.repoRootFsPath)!).push(file.relativePath);
    requested++;
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

  const absolutePath = joinFsPath(file.repoRootFsPath, file.relativePath);
  const key = batchKey(file.repoRootFsPath, file.relativePath);
  let content: string | undefined;
  if (payload.hash === UNCOMMITTED_HASH && deps.readWorking) {
    content = await deps.readWorking(absolutePath);            // working-tree (uncommitted) view — reads disk
  } else if (batch.has(key)) {
    content = batch.get(key);                                  // resolved by the single cat-file batch (git -C root)
  } else {
    // Only the per-file `git show` fallback needs the vscode.git repo object.
    // Reaching here means the working-tree/batch reads above didn't apply (no
    // readWorking, or the cat-file batch failed/was skipped). If vscode.git also
    // doesn't know this repo, there's nothing left to try → missing.
    const repo = deps.resolveRepo(file.repoRootFsPath);
    if (!repo) {
      return { clipboardPath, changeType, kind: 'missing' };
    }
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
  const skippedFiles: Array<{ path: string; bytes: number }> = [];
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
      skippedFiles.push({ path: file.clipboardPath, bytes: size });
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
    files,
    // Paths are relative to the commit's repo root; record its folder name so
    // restore can align folder levels. Only when every file is from one repo —
    // a multi-repo selection has no single source root.
    sourceRoot: singleRepoRoot(payload.files)
  });

  return { text, copiedFileCount, skippedFileSizeCount, skippedFiles, fileLimitReached, missingRepoCount };
}
