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

export function listCommitFiles(repo: HistoryRepo, commit: HistoryCommit): Promise<HistoryChange[]> {
  const ref1 = commit.parents[0] ?? EMPTY_TREE;
  return repo.diffBetweenWithStats(ref1, commit.hash);
}

export async function readFileAtCommit(
  repo: HistoryRepo,
  hash: string,
  change: HistoryChange
): Promise<string | undefined> {
  if (mapGitStatusToChangeType(change.status) === 'DELETED') {
    return DELETED_FILE_MARKER;
  }
  const target = (change.renameUri ?? change.uri).fsPath;
  return readRefContent(repo, hash, target);
}
