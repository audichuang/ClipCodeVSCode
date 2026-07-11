import * as path from 'path';
import { GitService } from '../git/git-service';
import type { WorkbenchStatus, RepoStatus, WorkbenchFileChange } from './workbench-messages';

type ServiceFactory = (repoPath: string) => GitService;

/**
 * Build the per-repo change model the workbench renders (D3 minimal).
 * Pure/vscode-free: repo discovery happens in the provider (Task 5), which
 * passes the resolved repo paths in. `makeService` is injectable for tests.
 *
 * Each repo is fetched independently and a failure in one repo degrades to an
 * empty file list for that repo rather than failing the whole panel.
 */
export async function getWorkbenchStatus(
  repoPaths: string[],
  makeService: ServiceFactory = (p) => new GitService(p),
): Promise<WorkbenchStatus> {
  const repos = await Promise.all(repoPaths.map((repoPath) => repoStatus(repoPath, makeService)));
  return { repos };
}

async function repoStatus(repoPath: string, makeService: ServiceFactory): Promise<RepoStatus> {
  const svc = makeService(repoPath);
  const base: RepoStatus = {
    repoPath,
    repoName: path.basename(repoPath),
    files: [],
    operationState: 'clean',
    indexDirty: false,
    detached: false,
    commitDisabledReason: null,
  };

  try {
    const [diff, operationState, branches] = await Promise.all([
      svc.getUncommittedDiff(),
      svc.getRepoOperationState(),
      svc.branches().catch(() => []),
    ]);

    base.operationState = operationState;
    base.indexDirty = diff.staged.length > 0;              // D1: any staged content
    base.detached = branches.find((b) => b.current)?.detached === true;

    // Hunk counts per unstaged file (index is expected clean under D1; we still
    // read the worktree side only). Non-hunkable types → whole-file.
    base.files = await Promise.all(
      diff.unstaged.map((entry) => fileChange(svc, entry)),
    );

    base.commitDisabledReason = disabledReason(base);
  } catch {
    // Whole-repo status failed (e.g. transient git error): show it as an empty,
    // commit-disabled group rather than dropping the repo silently.
    base.commitDisabledReason = 'status unavailable';
  }
  return base;
}

async function fileChange(
  svc: GitService,
  entry: { path: string; status: string },
): Promise<WorkbenchFileChange> {
  // Nested repos (status 'N') are never per-hunk stageable.
  if (entry.status === 'N') {
    return { path: entry.path, changeType: entry.status, hunkCount: 0, hunkable: false };
  }
  const diff = await svc.getUncommittedFileDiff(entry.path, false).catch(() => null);
  if (!diff || diff.isBinary) {
    return { path: entry.path, changeType: entry.status, hunkCount: 0, hunkable: false };
  }
  return {
    path: entry.path,
    changeType: entry.status,
    hunkCount: diff.hunks.length,
    hunkable: true,
  };
}

/**
 * D1/D4: an in-progress op or index non-empty blocks commit; detached only warns.
 * Operation state is checked FIRST: an unresolved merge/rebase conflict reports
 * unmerged paths as staged ('U' on both porcelain columns), which would
 * otherwise trip the D1 indexDirty message and mask the more specific D4 one.
 */
function disabledReason(s: RepoStatus): string | null {
  if (s.operationState !== 'clean') {
    return `此 repo 有進行中的 ${s.operationState}，請先完成或中止`;
  }
  if (s.indexDirty) {
    return '此 repo 已有預先暫存的變更，請先在原生 SCM 提交或重置後再用此面板';
  }
  return null;
}
