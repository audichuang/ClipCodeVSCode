import { realpathSync } from 'node:fs';
import type { ChangeTypeLabel, PayloadFile } from './clipboardFormat.js';
import { buildGitPayload } from './clipboardFormat.js';
import { mapInOrder } from './concurrency.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';
import { fileMatchesFilters } from './filterMatcher.js';
import type { FilterRule } from './settings.js';
import { readRefClassified, readRefContent, type ContentRepo } from './gitContent.js';
import type { FileContent } from './fileSystem.js';
import type { NonTextSummary } from './nonTextDialog.js';
import { sourceRootName, toClipboardPathFromRoots } from './pathResolver.js';
import { LEFT_OUT_CAP, UNREADABLE_PATHS_KEPT } from './copy.js';
import { defaultSettings } from './settings.js';

// Each file's content comes from one `git show` subprocess; fan them out so a
// large selection doesn't run them strictly one-at-a-time.
const READ_CONCURRENCY = 16;

export interface GraphCopyFile {
  repoRootFsPath: string;
  relativePath: string;
  oldRelativePath?: string;
  status: string; // canonical 'A'|'M'|'D'|'R'|'C' per spec §5.0;容忍 'R100'/'C75'
  // A deleted file's own "before" revisions, for a multi-commit union where each file was
  // deleted by a different commit (every parent of each deleting commit, in order).
  // Tried before payload.baseRef.
  beforeRefs?: string[];
}

export interface GraphCopyPayload {
  hash: string;
  // The "before" side when the files are a diff between two refs rather than one commit
  // against its parents: the PR merge-base, or compare mode's first ref. A file deleted by
  // an earlier commit of the range is absent from `hash`'s parents, so without this the
  // copy fell back to the bare marker where IntelliJ reads the pre-deletion content.
  baseRef?: string;
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
  /** Non-text blobs over this are size placeholders under Include. Defaults to the setting's default. */
  maxNonTextFileSizeKB?: number;
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
  readWorking?(absolutePath: string): Promise<FileContent | undefined>;
  // Reads many committed blobs at a hash in ONE `git cat-file --batch` process,
  // bypassing the vscode.git per-repo operation queue that throttles N concurrent
  // show() calls. Returns relativePath -> classified content (no key for a missing object).
  // Optional: when absent (or on spawn failure) the per-file reader is used.
  readBatch?(repoRootFsPath: string, hash: string, relativePaths: string[]): Promise<Map<string, FileContent | undefined>>;
  /**
   * The workspace folders, in order — the same list Paste & Restore resolves against.
   * Every payload (single- or multi-repo) labels its paths and `clipcode-root` the way THIS
   * list says, because that is the only labelling the restore side can read back.
   * Optional; without it a single-repo payload stays repo-relative and a multi-repo one
   * falls back to repo basenames, which restore cannot align.
   */
  workspaceRoots?: string[];
  settings: GraphCopySettings;
}

export interface GraphCopyOptions {
  /**
   * Carry non-text blobs (NUL or not strict UTF-8) as Base64 entries. False is the payload
   * from before non-text support, byte for byte: they are dropped and counted.
   */
  includeNonText: boolean;
  /** Tests only: a smaller LEFT_OUT_CAP. */
  leftOutCap?: number;
}

export interface GraphCopyResult extends NonTextSummary {
  text: string;
  copiedFileCount: number;
  skippedFileSizeCount: number;
  /** Non-text (Exclude only) or unreadable — dropped, and previously without a word. */
  skippedUnreadableCount: number;
  /** Exclude only: the non-text part of skippedUnreadableCount. */
  excludedNonTextCount: number;
  // The files dropped for exceeding maxFileSizeKB, so the caller can list them
  // instead of only showing a count.
  skippedFiles: Array<{ path: string; bytes: number }>;
  fileLimitReached: boolean;
  missingRepoCount: number;
  /** First UNREADABLE_PATHS_KEPT unreadable paths (non-text left out by Exclude not among them). */
  unreadablePaths: string[];
}

function joinFsPath(root: string, relativePath: string): string {
  return `${root.replace(/[/\\]+$/, '')}/${relativePath}`;
}

interface PreparedFile {
  clipboardPath: string;
  /**
   * The path relative to ITS OWN repo, kept separate from clipboardPath because that is
   * workspace-relative (or, with no workspace, basename-prefixed for a multi-repo payload).
   * Joining it onto the repo root produced `<root>/<repoName>/<path>`, a path that exists
   * nowhere, so every absolute-path filter rule silently stopped matching.
   */
  relativePath: string;
  /**
   * What the FILTER rules are matched against — always workspace-relative. With a workspace
   * it is the same string as clipboardPath; the fields differ only with no workspace root,
   * where the header falls back to repo-relative (or basename-prefixed for a multi-repo
   * payload) while the filter path stays whatever the other surfaces filter against. IntelliJ keeps
   * them apart too (CopyPathFormatter.relativeFilterPath vs toClipboardPath).
   */
  filterPath: string;
  /** Carried so dedupe is per repo — two repos legitimately hold the same relative path. */
  repoRootFsPath: string;
  changeType: ChangeTypeLabel;
  kind: 'deleted' | 'missing' | 'content';
  /** Deleted: the pre-deletion TEXT only (a [DELETED] body is never read on paste). */
  content?: FileContent;
}

function batchKey(repoRootFsPath: string, relativePath: string): string {
  return `${repoRootFsPath}\n${relativePath}`;
}

function trimSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function realOrSelf(p: string): string {
  try { return trimSlashes(realpathSync(p)); } catch { return trimSlashes(p); }
}

function isUnder(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/**
 * Spell a file under the repo the way the workspace spells it. `git rev-parse
 * --show-toplevel` hands the Graph a REALPATH (`/private/tmp/ws`) while VS Code reports the
 * workspace through the symlink the user opened (`/tmp/ws`); relativizing by string prefix
 * then fails and the header leaks an absolute path. When the plain spelling is already
 * under a root nothing changes; otherwise both sides are realpath'd and the file is
 * re-anchored on the workspace root's own spelling. A file under no root keeps its path.
 */
function workspaceSpelling(workspaceRoots: string[], repoRootFsPath: string, relativePath: string): string {
  const plain = joinFsPath(repoRootFsPath, relativePath);
  if (workspaceRoots.some(r => isUnder(trimSlashes(r), trimSlashes(plain)))) return plain;
  const real = joinFsPath(realOrSelf(repoRootFsPath), relativePath);
  for (const root of workspaceRoots) {
    const realRoot = realOrSelf(root);
    if (isUnder(realRoot, real)) return `${trimSlashes(root)}${real.slice(realRoot.length)}`;
  }
  return plain;
}

function baseNameOf(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
}

/**
 * The clipboard path of a file. With workspace roots this is the same spelling the SCM and
 * History surfaces and IntelliJ's GitClipboardPayloadBuilder use (relative to the opened
 * workspace/project root, non-primary roots labelled), so a nested repo `M/repo` copies as
 * `repo/src/a.ts` under `clipcode-root: M`. Without any workspace root there is nothing to
 * anchor on: single-repo payloads stay repo-relative, and a payload spanning repositories
 * prefixes each repo's basename so two repos holding the same path do not collide.
 */
function clipboardPathFor(
  workspaceRoots: string[] | undefined,
  repoRootFsPath: string,
  relativePath: string,
  multiRepo: boolean
): string {
  if (workspaceRoots?.length) return workspaceRelativePath(workspaceRoots, repoRootFsPath, relativePath);
  return multiRepo ? `${baseNameOf(repoRootFsPath)}/${relativePath}` : relativePath;
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
  return toClipboardPathFromRoots(workspaceRoots, workspaceSpelling(workspaceRoots, repoRootFsPath, relativePath));
}

// No-workspace fallback only: the repo folder name shared by every file, or undefined if
// they span repos. With workspace roots the root name comes from sourceRootName instead.
function singleRepoRoot(files: GraphCopyFile[]): string | undefined {
  const roots = new Set(files.map(f => f.repoRootFsPath));
  return roots.size === 1 ? baseNameOf([...roots][0]) : undefined;
}

// Prefetch committed blob contents up front with one `git cat-file --batch` per
// repo (parallel across repos). For the uncommitted view or when no readBatch is
// provided this returns an empty map and prepareFile falls back to per-file reads.
async function prefetchBatch(deps: GraphCopyDeps, payload: GraphCopyPayload): Promise<Map<string, FileContent | undefined>> {
  const lookup = new Map<string, FileContent | undefined>();
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
    const contents = await deps.readBatch!(root, payload.hash, paths).catch(() => new Map<string, FileContent | undefined>());
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
  batch: Map<string, FileContent | undefined>,
  multiRepo: boolean
): Promise<PreparedFile> {
  // §5.0:R/C 帶相似度時截到字首後再對應
  const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
  const repoRootFsPath = file.repoRootFsPath;
  // Same spelling as the SCM/History surfaces (workspace-root anchored); see clipboardPathFor.
  const clipboardPath = clipboardPathFor(deps.workspaceRoots, repoRootFsPath, file.relativePath, multiRepo);
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
    // From the webview: never let a ref read as a git option (`git show -x:path`).
    const safe = (ref?: string) => (ref && !ref.startsWith('-') ? [ref] : []);
    const parentRefs = [
      ...(file.beforeRefs ?? []).flatMap(safe),
      ...safe(payload.baseRef),
      ...(payload.hash === UNCOMMITTED_HASH
        ? ['HEAD']
        : [`${payload.hash}^1`, `${payload.hash}^2`, `${payload.hash}^3`])
    ];
    // Text only (readRefContent): a non-text pre-deletion blob keeps today's bare marker.
    let before: string | undefined;
    if (repo) {
      const absolute = joinFsPath(repoRootFsPath, file.relativePath);
      for (const ref of parentRefs) {
        before = await readRefContent(repo, ref, absolute);
        if (before !== undefined) break;
      }
    }
    return {
      clipboardPath, filterPath, relativePath: file.relativePath, repoRootFsPath, changeType, kind: 'deleted',
      content: before === undefined ? undefined : { text: before }
    };
  }

  const absolutePath = joinFsPath(file.repoRootFsPath, file.relativePath);
  const key = batchKey(file.repoRootFsPath, file.relativePath);
  let content: FileContent | undefined;
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
    content = await readRefClassified(repo, payload.hash, absolutePath); // fallback: `git show <hash>:<path>`
  }
  return { clipboardPath, filterPath, relativePath: file.relativePath, repoRootFsPath, changeType, kind: 'content', content };
}

function passesFilters(deps: GraphCopyDeps, file: Pick<PreparedFile, 'filterPath' | 'repoRootFsPath' | 'relativePath'>): boolean {
  const { settings } = deps;
  if (!settings.useFilters) return true;
  if (!fileMatchesFilters(
    file.filterPath,
    settings.filterRules ?? [],
    settings.useIncludeFilters === true,
    settings.useExcludeFilters === true,
    // The file's OWN relative path — clipboardPath is workspace-relative (or basename-prefixed
    // with no workspace), and joining that onto the repo root produced `<root>/<repoName>/<path>`.
    deps.workspaceRoots?.length
      ? workspaceSpelling(deps.workspaceRoots, file.repoRootFsPath, file.relativePath)
      : joinFsPath(file.repoRootFsPath, file.relativePath)
  )) {
    return false;
  }
  // The workspace spelling above can differ from the physical path git reports (symlinked
  // workspace). An absolute EXCLUDE written against the physical path must still hit, so
  // run an exclude-only pass on it; includes stay judged on the workspace spelling alone.
  if (deps.workspaceRoots?.length) {
    const physical = joinFsPath(file.repoRootFsPath, file.relativePath);
    if (physical !== workspaceSpelling(deps.workspaceRoots, file.repoRootFsPath, file.relativePath) &&
        !fileMatchesFilters(file.filterPath, settings.filterRules ?? [], false, settings.useExcludeFilters === true, physical)) {
      return false;
    }
  }
  return true;
}

export async function buildGraphCopyPayload(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload,
  options: GraphCopyOptions = { includeNonText: false }
): Promise<GraphCopyResult> {
  const { settings } = deps;
  const nonTextLimit = (settings.maxNonTextFileSizeKB ?? defaultSettings.maxNonTextFileSizeKB) * 1024;
  const files: PayloadFile[] = [];
  const skippedFiles: Array<{ path: string; bytes: number }> = [];
  const nonTextFiles: Array<{ path: string; size: number }> = [];
  let nonTextTotalBytes = 0;
  let nonTextOverLimitCount = 0;
  let excludedNonTextCount = 0;
  let skippedUnreadableCount = 0;
  let copiedFileCount = 0;
  let skippedFileSizeCount = 0;
  let missingRepoCount = 0;
  let fileLimitReached = false;
  let limitLeftOut = 0;
  let limitLeftOutCapped = false;
  const leftOutCap = options.leftOutCap ?? LEFT_OUT_CAP;
  const unreadablePaths: string[] = [];

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
  let index = -1;
  for await (const file of prepared) {
    index++;
    const key = `${file.repoRootFsPath}\u0000${file.clipboardPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }

    if (file.kind === 'missing') {
      missingRepoCount++;
      continue;
    }

    if (!passesFilters(deps, file)) continue;

    // A deleted entry goes through the filters above and the size limit below like any
    // other: it carries the pre-deletion body, so skipping them leaked excluded files.
    if (file.kind === 'deleted' && file.content === undefined) {
      files.push({ path: file.clipboardPath, content: DELETED_FILE_MARKER, changeType: file.changeType });
      copiedFileCount++;
      continue;
    }

    const read = file.content;
    if (read === undefined) {
      // Unreadable. Counting it is the difference between "this file could not be
      // copied" and the file simply not being there.
      skippedUnreadableCount++;
      if (unreadablePaths.length < UNREADABLE_PATHS_KEPT) unreadablePaths.push(file.clipboardPath);
      continue;
    }

    if ('nonText' in read) {
      if (!options.includeNonText) {
        // Exclude: dropped and counted, exactly the payload from before non-text support.
        skippedUnreadableCount++;
        excludedNonTextCount++;
        continue;
      }
      const size = read.nonText.length;
      if (size > nonTextLimit) {
        skippedFileSizeCount++;
        nonTextOverLimitCount++;
        skippedFiles.push({ path: file.clipboardPath, bytes: size });
        files.push({ path: file.clipboardPath, changeType: file.changeType, skippedReason: `size exceeds limit (${size} bytes)` });
        continue;
      }
      files.push({ path: file.clipboardPath, nonText: read.nonText, changeType: file.changeType });
      nonTextFiles.push({ path: file.clipboardPath, size });
      nonTextTotalBytes += size;
      copiedFileCount++;
      continue;
    }

    const content = read.text;
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

  if (fileLimitReached) {
    // What the limit left out, judged on paths alone (dedupe + filters), with no reads:
    // the dialog and the notice say how many files the limit cut off.
    for (const file of payload.files.slice(index)) {
      const clipboardPath = clipboardPathFor(deps.workspaceRoots, file.repoRootFsPath, file.relativePath, multiRepo);
      const key = `${file.repoRootFsPath}\u0000${clipboardPath}`;
      if (seen.has(key) && file !== payload.files[index]) continue;
      seen.add(key);
      const filterPath = workspaceRelativePath(deps.workspaceRoots, file.repoRootFsPath, file.relativePath);
      if (passesFilters(deps, { filterPath, repoRootFsPath: file.repoRootFsPath, relativePath: file.relativePath })) {
        // Stop at the first one past the cap: the number only has to say "a lot".
        if (limitLeftOut >= leftOutCap) { limitLeftOutCapped = true; break; }
        limitLeftOut++;
      }
    }
  }

  const text = buildGitPayload({
    headerFormat: settings.headerFormat,
    preText: settings.preText,
    postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
    files,
    // Paths are relative to the workspace root, exactly like SCM/History/IntelliJ, so the
    // root line names that workspace root (none for several roots). Only with no workspace
    // at all do paths stay repo-relative, and then the single repo's name is the base.
    sourceRoot: deps.workspaceRoots?.length ? sourceRootName(deps.workspaceRoots) : singleRepoRoot(payload.files)
  });

  return {
    text, copiedFileCount, skippedFileSizeCount, skippedUnreadableCount, excludedNonTextCount, skippedFiles,
    fileLimitReached, missingRepoCount, limitLeftOut, limitLeftOutCapped, unreadablePaths, nonTextFiles, nonTextTotalBytes, nonTextOverLimitCount,
    // A blob is always read whole (cat-file), so nothing here is "over both limits, unread".
    unreadOverLimitCount: 0,
    estimatedBytes: Buffer.byteLength(text, 'utf8')
  };
}
