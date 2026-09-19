import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ContentRepo } from './gitContent.js';
import { readRefContent } from './gitContent.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface HistoryCommit {
  hash: string;
  message: string;
  parents: string[];
  commitDate?: Date;
  authorName?: string;
  authorEmail?: string;
}

export interface HistoryChange {
  uri: { fsPath: string };
  originalUri?: { fsPath: string };
  renameUri?: { fsPath: string };
  status: unknown;
}

export interface HistoryRepo extends ContentRepo {
  rootUri: { fsPath: string };
  log(options: { maxEntries?: number; skip?: number }): Promise<HistoryCommit[]>;
  diffBetweenWithStats(ref1: string, ref2: string): Promise<HistoryChange[]>;
}

export function listCommits(repo: HistoryRepo, opts: { limit: number; skip: number }): Promise<HistoryCommit[]> {
  return repo.log({ maxEntries: opts.limit, skip: opts.skip });
}

/**
 * `git rev-parse --is-shallow-repository` is exactly "does $GIT_DIR/shallow exist and hold
 * anything" — read it directly, because the History view holds only the Git extension's
 * Repository and has no git binary to spawn. Mirror of the sibling guards in
 * git-service.ts showCommitFilesWithParents and Kotlin GitContentResolver.
 */
export function isShallowRepository(repoRootFsPath: string): boolean {
  try {
    const dotGit = path.join(repoRootFsPath, '.git');
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      // Worktrees and submodules: `.git` is a file pointing at the real git dir.
      const pointer = readTrimmed(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1];
      if (!pointer) return false;
      gitDir = path.isAbsolute(pointer) ? pointer : path.join(repoRootFsPath, pointer);
    }
    // A linked worktree's git dir holds `commondir`; `shallow` lives in that common dir,
    // not per worktree — without this hop the guard reports "not shallow" for every
    // worktree of a shallow clone, which is the case it exists for.
    const common = readTrimmed(path.join(gitDir, 'commondir'));
    if (common) gitDir = path.isAbsolute(common) ? common : path.join(gitDir, common);
    return statSync(path.join(gitDir, 'shallow')).size > 0;
  } catch {
    return false;
  }
}

function readTrimmed(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function listCommitFiles(repo: HistoryRepo, commit: HistoryCommit): Promise<HistoryChange[]> {
  if (commit.parents.length === 0 && isShallowRepository(repo.rootUri.fsPath)) {
    // A shallow clone grafts boundary commits so they report no parents. Diffing one
    // against the empty tree copies the ENTIRE repository as "this commit's change" — the
    // Graph entry has refused that for a while, this one still did it.
    throw new Error(
      `Repository history is shallow, so the parent of ${commit.hash} is not available locally. ` +
      `Run 'git fetch --unshallow' and try again.`
    );
  }
  if (commit.parents.length <= 1) {
    return repo.diffBetweenWithStats(commit.parents[0] ?? EMPTY_TREE, commit.hash);
  }
  // A merge is the UNION of its diffs against every parent. Against the first parent alone
  // it hides everything that arrived through parents 2..N — silent loss on every octopus
  // merge. The Graph entry has always done it this way; this one and IntelliJ did not, so
  // the same merge produced three different file sets across the two tools.
  const byPath = new Map<string, HistoryChange>();
  for (const parent of commit.parents) {
    for (const change of await repo.diffBetweenWithStats(parent, commit.hash)) {
      const key = (change.renameUri ?? change.uri).fsPath;
      if (!byPath.has(key)) byPath.set(key, change);
    }
  }
  return [...byPath.values()];
}

export async function readFileAtCommit(
  repo: HistoryRepo,
  hash: string,
  change: HistoryChange,
  /** The commit's parents — a deleted file's content is read from the one that still had it. */
  parents: readonly string[] = []
): Promise<string | undefined> {
  const target = (change.renameUri ?? change.uri).fsPath;
  if (mapGitStatusToChangeType(change.status) === 'DELETED') {
    // The PRE-DELETION content, not a bare marker: that is what IntelliJ puts on the
    // clipboard on every path, and what this tool's own SCM path does — only Graph, PR and
    // History emitted the marker, so the same deletion looked different depending on which
    // surface copied it. The marker stays as the fallback when no parent still has it.
    for (const parent of parents.length > 0 ? parents : [`${hash}^`]) {
      const before = await readRefContent(repo, parent, (change.originalUri ?? change.uri).fsPath);
      if (before !== undefined) return before;
    }
    return DELETED_FILE_MARKER;
  }
  return readRefContent(repo, hash, target);
}
