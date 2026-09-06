// Pure builder for the commit workbench's change tree. Turns per-repo staged/
// unstaged status into the IntelliJ-style hierarchy the TreeDataProvider paints:
//   Staged   → repo → file
//   Unstaged → repo → file
// No `vscode` import so it stays unit-testable. The provider wraps these nodes
// into vscode.TreeItem (resourceUri → native file icon + git decoration color).

/* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
export type ChangeGroup = 'staged' | 'unstaged' | 'conflict';
/* SNIPCODE-HOOK end */

export interface RepoStatus {
  repoName: string;
  repoPath: string;
  /** Current branch (or '' / 'HEAD' when detached/unborn). */
  branch: string;
  /** Commits ahead/behind upstream (undefined when there is no upstream). */
  ahead?: number;
  behind?: number;
  /* SNIPCODE-HOOK start: Batch B rename staging paths */
  staged: Array<{ path: string; status: string; oldPath?: string }>;
  unstaged: Array<{ path: string; status: string; oldPath?: string }>;
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK start: R3/S3 unmerged files, kept out of staged/unstaged */
  conflict: Array<{ path: string; status: string; oldPath?: string }>;
  /* SNIPCODE-HOOK end */
}

export interface FileNode {
  kind: 'file';
  repoPath: string;
  /** Repo-relative path (already the new path for renames). */
  path: string;
  /* SNIPCODE-HOOK start: Batch B rename staging paths */
  oldPath?: string;
  /* SNIPCODE-HOOK end */
  status: string;
  group: ChangeGroup;
}

export interface RepoNode {
  kind: 'repo';
  repoName: string;
  repoPath: string;
  branch: string;
  ahead?: number;
  behind?: number;
  group: ChangeGroup;
  files: FileNode[];
}

export interface GroupNode {
  kind: 'group';
  group: ChangeGroup;
  label: string;
  /** Total files in this group across all repos. */
  count: number;
  repos: RepoNode[];
}

/* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
const GROUP_LABEL: Record<ChangeGroup, string> = { staged: 'Staged', unstaged: 'Unstaged', conflict: 'Merge Conflicts' };
/* SNIPCODE-HOOK end */

function groupNode(repos: RepoStatus[], group: ChangeGroup): GroupNode {
  const repoNodes: RepoNode[] = [];
  let count = 0;
  for (const repo of repos) {
    /* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
    const entries = group === 'staged' ? repo.staged : group === 'unstaged' ? repo.unstaged : repo.conflict;
    /* SNIPCODE-HOOK end */
    if (entries.length === 0) continue;
    count += entries.length;
    repoNodes.push({
      kind: 'repo',
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      branch: repo.branch,
      ahead: repo.ahead,
      behind: repo.behind,
      group,
      files: entries.map((e) => ({
        kind: 'file',
        repoPath: repo.repoPath,
        path: e.path,
        /* SNIPCODE-HOOK start: Batch B rename staging paths */
        oldPath: e.oldPath,
        /* SNIPCODE-HOOK end */
        status: e.status,
        group,
      })),
    });
  }
  return { kind: 'group', group, label: GROUP_LABEL[group], count, repos: repoNodes };
}

/** Build the top-level group nodes from per-repo status: always [Staged, Unstaged],
 *  plus a trailing Merge Conflicts group when any repo has unmerged files. A repo
 *  appears under a group only when it has files in that group; a file that is both
 *  staged and unstaged (e.g. `MM`) appears under BOTH groups (git's real index vs
 *  working-tree split). Staged/Unstaged are always returned, even when empty —
 *  Merge Conflicts is omitted entirely when there is nothing unresolved (R3/S3),
 *  so the tree doesn't show a permanent "Merge Conflicts 0" row. */
export function buildChangeTree(repos: RepoStatus[]): GroupNode[] {
  const groups = [groupNode(repos, 'staged'), groupNode(repos, 'unstaged')];
  /* SNIPCODE-HOOK start: R3/S3 conflict is a third change group */
  const conflict = groupNode(repos, 'conflict');
  if (conflict.count > 0) groups.push(conflict);
  /* SNIPCODE-HOOK end */
  return groups;
}
