import type { ChangeTypeLabel, PayloadFile } from './clipboardFormat.js';
import { buildGitPayload } from './clipboardFormat.js';
import { mapInOrder } from './concurrency.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';
import { fileMatchesFilters } from './filterMatcher.js';
import type { FilterRule } from './settings.js';
import { readRefContent, type ContentRepo } from './gitContent.js';
import { toClipboardPathFromRoots } from './pathResolver.js';

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
  // The ordinary filters. This surface had no filter fields at all, so an
  // `EXCLUDE PATH secrets.env` rule held on the SCM and History entries and silently did
  // nothing here — the same rule, the same repo, a different answer depending on which
  // view the user copied from. Optional so existing callers keep compiling with filters off.
  useFilters?: boolean;
  useIncludeFilters?: boolean;
  useExcludeFilters?: boolean;
  filterRules?: FilterRule[];
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
  /**
   * The workspace folders, in order — the same list Paste & Restore resolves against.
   * A payload spanning repositories must label its paths the way THIS list says, because
   * that is the only labelling the restore side can read back. Optional; without it a
   * multi-repo payload falls back to repo basenames, which restore cannot align.
   */
  workspaceRoots?: string[];
  settings: GraphCopySettings;
}

export interface GraphCopyResult {
  text: string;
  copiedFileCount: number;
  skippedFileSizeCount: number;
  /** Binary, non-UTF-8 or unreadable — dropped, and previously without a word. */
  skippedUnreadableCount: number;
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
  /**
   * The path relative to ITS OWN repo, kept separate from clipboardPath because a
   * multi-repo payload prefixes the latter with the repo basename. Joining that prefixed
   * path onto the repo root produced `<root>/<repoName>/<path>`, a path that exists
   * nowhere, so every absolute-path filter rule silently stopped matching.
   */
  relativePath: string;
  /**
   * What the FILTER rules are matched against — always workspace-relative, and therefore
   * NOT the same string as clipboardPath.
   *
   * The two were one field, so a single-repo graph copy filtered against the repo-relative
   * header (`secret.txt`) while SCM and History filter against the workspace-relative path
   * (`beta/secret.txt`): an `EXCLUDE PATH beta/secret.txt` rule held everywhere except
   * here. The header must stay repo-relative — the `clipcode-root` line names that repo and
   * the two have to describe the same base — so the filter needs its own path. IntelliJ has
   * always kept them apart (CopyPathFormatter.relativeFilterPath vs toClipboardPath).
   */
  filterPath: string;
  /** Carried so dedupe is per repo — two repos legitimately hold the same relative path. */
  repoRootFsPath: string;
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

/**
 * The clipboard path for a payload that spans repositories.
 *
 * Prefixing EVERY repo with its basename — the first attempt at the same-name collision —
 * produced a labelling no other surface uses and restore cannot read: with workspace roots
 * `[alpha, beta]`, `alpha/secret.txt` resolved to `alpha/alpha/secret.txt`, and an
 * `EXCLUDE PATH secret.txt` rule that held on the SCM and History entries missed it here.
 * Every other surface — those two, and IntelliJ's GitClipboardPayloadBuilder — labels via
 * the workspace roots: the PRIMARY root's files stay unlabelled, the others carry their
 * label. Use the same function they do. Single-repo payloads keep their repo-relative
 * paths (and their `clipcode-root` line, which names that repo) untouched.
 */
function multiRepoClipboardPath(
  workspaceRoots: string[] | undefined,
  repoRootFsPath: string,
  relativePath: string
): string {
  if (!workspaceRoots?.length) return `${baseNameOf(repoRootFsPath)}/${relativePath}`;
  return workspaceRelativePath(workspaceRoots, repoRootFsPath, relativePath);
}

/**
 * The workspace-relative spelling every other copy surface filters against. Falls back to
 * the repo-relative path only when there is no workspace to anchor on.
 */
function workspaceRelativePath(
  workspaceRoots: string[] | undefined,
  repoRootFsPath: string,
  relativePath: string
): string {
  if (!workspaceRoots?.length) return relativePath;
  return toClipboardPathFromRoots(workspaceRoots, joinFsPath(repoRootFsPath, relativePath));
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
  batch: Map<string, string | undefined>,
  multiRepo: boolean
): Promise<PreparedFile> {
  // §5.0:R/C 帶相似度時截到字首後再對應
  const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
  const repoRootFsPath = file.repoRootFsPath;
  // Two repositories legitimately hold the same relative path. Emitting both as a bare
  // `a.txt` produced two identical headers, and restore then pointed both at one
  // destination — the second repository's file was never written. IntelliJ labels the
  // non-primary root (`other/b.ts`); do the same when the payload spans repositories.
  const clipboardPath = multiRepo
    ? multiRepoClipboardPath(deps.workspaceRoots, repoRootFsPath, file.relativePath)
    : file.relativePath;
  const filterPath = workspaceRelativePath(deps.workspaceRoots, repoRootFsPath, file.relativePath);

  if (changeType === 'DELETED') {
    // The PRE-DELETION content, not a bare marker: that is what IntelliJ puts on the
    // clipboard on every path, and what this tool's own SCM path does. The marker stays as
    // the fallback when the parent revision cannot be read (a root commit, a shallow
    // boundary). Restore is unaffected either way — a [DELETED] label discards the body.
    const repo = deps.resolveRepo(repoRootFsPath);
    // EVERY parent, not just the first. A merge can delete a file that only the second
    // parent ever had, and asking `hash^` alone then found nothing and fell back to the
    // marker — while the History surface, which tries all parents, returned the body.
    const parentRefs = payload.hash === UNCOMMITTED_HASH
      ? ['HEAD']
      : [`${payload.hash}^1`, `${payload.hash}^2`, `${payload.hash}^3`];
    let before: string | undefined;
    if (repo) {
      const absolute = joinFsPath(repoRootFsPath, file.relativePath);
      for (const ref of parentRefs) {
        before = await readRefContent(repo, ref, absolute);
        if (before !== undefined) break;
      }
    }
    return { clipboardPath, filterPath, relativePath: file.relativePath, repoRootFsPath, changeType, kind: 'deleted', content: before };
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
      return { clipboardPath, filterPath, relativePath: file.relativePath, repoRootFsPath, changeType, kind: 'missing' };
    }
    content = await readRefContent(repo, payload.hash, absolutePath); // fallback: `git show <hash>:<path>`
  }
  return { clipboardPath, filterPath, relativePath: file.relativePath, repoRootFsPath, changeType, kind: 'content', content };
}

export async function buildGraphCopyPayload(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload
): Promise<GraphCopyResult> {
  const { settings } = deps;
  const files: PayloadFile[] = [];
  const skippedFiles: Array<{ path: string; bytes: number }> = [];
  let skippedUnreadableCount = 0;
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
  const multiRepo = new Set(payload.files.map(f => f.repoRootFsPath)).size > 1;
  const batch = await prefetchBatch(deps, payload);
  const prepared = mapInOrder(payload.files, READ_CONCURRENCY, file => prepareFile(deps, payload, file, batch, multiRepo));
  // The SCM path and IntelliJ both dedupe by path; this one did not, so a path selected in
  // both the staged and the unstaged tree landed in the payload twice. Keyed by REPO +
  // path: a multi-repo payload legitimately holds two `src/index.ts`, and keying on the
  // relative path alone would silently drop one of them.
  const seen = new Set<string>();
  for await (const file of prepared) {
    const key = `${file.repoRootFsPath}\u0000${file.clipboardPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }

    if (file.kind === 'deleted') {
      files.push({ path: file.clipboardPath, content: file.content ?? DELETED_FILE_MARKER, changeType: file.changeType });
      copiedFileCount++;
      continue;
    }

    if (file.kind === 'missing') {
      missingRepoCount++;
      continue;
    }

    if (settings.useFilters && !fileMatchesFilters(
      file.filterPath,
      settings.filterRules ?? [],
      settings.useIncludeFilters === true,
      settings.useExcludeFilters === true,
      // The file's OWN relative path — clipboardPath carries the repo-basename prefix in
      // a multi-repo payload, and joining that produced `<root>/<repoName>/<path>`.
      joinFsPath(file.repoRootFsPath, file.relativePath)
    )) {
      continue;
    }

    const content = file.content;
    if (content === undefined) {
      // Binary, non-UTF-8 or unreadable. Counting it is the difference between "this file
      // could not be copied" and the file simply not being there.
      skippedUnreadableCount++;
      continue;
    }

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

  return { text, copiedFileCount, skippedFileSizeCount, skippedUnreadableCount, skippedFiles, fileLimitReached, missingRepoCount };
}
