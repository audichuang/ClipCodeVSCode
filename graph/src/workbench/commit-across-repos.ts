import type { PerRepoSelection, RepoCommitResult } from './workbench-messages';

export interface CommitAcrossReposDeps {
  /** Serialize per repo path against Graph/other-panel mutations (D2). */
  runExclusive: <T>(repoPath: string, fn: () => Promise<T>) => Promise<T>;
  /** GitService.commitSelected bound to a repo path (provider injects the real one). */
  commitSelected: (
    repoPath: string,
    message: string,
    files: Array<{ path: string; hunkIndices: number[] }>,
    opts?: { amend?: boolean },
  ) => Promise<string>;
}

/**
 * Commit the checked files in each selected repo as N independent commits
 * sharing one message. git cannot make one commit span repos, so there is NO
 * cross-repo atomic rollback: each repo succeeds or fails on its own, and the
 * caller keeps the selection for failed repos (so a retry never double-commits
 * an already-successful repo). Whole-file selection expands to all hunks.
 */
export async function commitAcrossRepos(
  deps: CommitAcrossReposDeps,
  message: string,
  selections: PerRepoSelection[],
  opts?: { amend?: boolean },
): Promise<RepoCommitResult[]> {
  const results: RepoCommitResult[] = [];
  for (const sel of selections) {
    const files = sel.files.map((f) => ({
      path: f.path,
      hunkIndices: wholeFileHunks(f.hunkCount),
    }));
    try {
      const newHead = await deps.runExclusive(sel.repoPath, () =>
        deps.commitSelected(sel.repoPath, message, files, opts),
      );
      results.push({ repoPath: sel.repoPath, ok: true, newHead });
    } catch (err) {
      results.push({ repoPath: sel.repoPath, ok: false, error: errText(err) });
    }
  }
  return results;
}

/** [0..n-1]; a non-hunkable/whole file always reports hunkCount 1 (Task 2). */
function wholeFileHunks(hunkCount: number): number[] {
  const n = Math.max(1, hunkCount);
  return Array.from({ length: n }, (_, i) => i);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
