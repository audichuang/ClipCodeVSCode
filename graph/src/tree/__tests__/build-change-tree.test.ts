import { describe, it, expect } from 'vitest';
import { buildChangeTree, type RepoStatus } from '../build-change-tree';

const repo = (over: Partial<RepoStatus>): RepoStatus => ({
  repoName: 'r', repoPath: '/r', branch: 'main', staged: [], unstaged: [], conflict: [], ...over,
});

describe('buildChangeTree', () => {
  it('always returns [Staged, Unstaged] groups, empty when nothing changed', () => {
    const [staged, unstaged] = buildChangeTree([]);
    expect(staged.group).toBe('staged');
    expect(staged.label).toBe('Staged');
    expect(staged.count).toBe(0);
    expect(staged.repos).toEqual([]);
    expect(unstaged.group).toBe('unstaged');
    expect(unstaged.count).toBe(0);
  });

  it('groups files under Staged/Unstaged → repo → file across multiple repos', () => {
    const [staged, unstaged] = buildChangeTree([
      repo({ repoName: 'app', repoPath: '/app', staged: [{ path: 'a.ts', status: 'M' }], unstaged: [{ path: 'b.ts', status: 'M' }] }),
      repo({ repoName: 'lib', repoPath: '/lib', unstaged: [{ path: 'c.ts', status: 'A' }] }),
    ]);

    // Staged: only app (1 file).
    expect(staged.count).toBe(1);
    expect(staged.repos.map((r) => r.repoName)).toEqual(['app']);
    expect(staged.repos[0].files.map((f) => f.path)).toEqual(['a.ts']);
    expect(staged.repos[0].files[0].group).toBe('staged');

    // Unstaged: app (b) + lib (c) = 2 files across two repos.
    expect(unstaged.count).toBe(2);
    expect(unstaged.repos.map((r) => r.repoName)).toEqual(['app', 'lib']);
    expect(unstaged.repos[1].files[0].path).toBe('c.ts');
  });

  it('shows a file that is both staged and unstaged (MM) under BOTH groups', () => {
    const [staged, unstaged] = buildChangeTree([
      repo({ repoPath: '/r', staged: [{ path: 'x.ts', status: 'M' }], unstaged: [{ path: 'x.ts', status: 'M' }] }),
    ]);
    expect(staged.repos[0].files[0].path).toBe('x.ts');
    expect(unstaged.repos[0].files[0].path).toBe('x.ts');
  });

  it('carries repo branch and file status through (incl. rename R and untracked U)', () => {
    const [staged, unstaged] = buildChangeTree([
      repo({ repoName: 'app', branch: 'feature/x', staged: [{ path: 'new-name.ts', status: 'R' }], unstaged: [{ path: 'fresh.ts', status: 'U' }] }),
    ]);
    expect(staged.repos[0].branch).toBe('feature/x');
    expect(staged.repos[0].files[0].status).toBe('R');
    expect(unstaged.repos[0].files[0].status).toBe('U');
  });

  /* SNIPCODE-HOOK start: R3/S3 conflict group */
  it('omits the Merge Conflicts group entirely when nothing is unmerged', () => {
    const groups = buildChangeTree([repo({})]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.group)).toEqual(['staged', 'unstaged']);
  });

  it('puts unmerged files in a trailing Merge Conflicts group, not staged/unstaged', () => {
    const groups = buildChangeTree([
      repo({ conflict: [{ path: 'both.ts', status: '!' }], staged: [{ path: 'clean.ts', status: 'M' }] }),
    ]);
    expect(groups).toHaveLength(3);
    const conflict = groups[2];
    expect(conflict.group).toBe('conflict');
    expect(conflict.label).toBe('Merge Conflicts');
    expect(conflict.count).toBe(1);
    expect(conflict.repos[0].files[0]).toMatchObject({ path: 'both.ts', status: '!', group: 'conflict' });
    // The conflicted file must not also appear under Staged/Unstaged.
    const [staged, unstaged] = groups;
    expect(staged.repos[0].files.map((f) => f.path)).toEqual(['clean.ts']);
    expect(unstaged.repos).toEqual([]);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S12 error group */
  it('omits the Repository Errors group when every repo read cleanly', () => {
    const groups = buildChangeTree([repo({})]);
    expect(groups.some((g) => g.group === 'error')).toBe(false);
  });

  it('puts a repo whose status failed to read in a trailing Repository Errors group', () => {
    const groups = buildChangeTree([
      repo({ repoName: 'ok', repoPath: '/ok', staged: [{ path: 'a.ts', status: 'M' }] }),
      repo({ repoName: 'broken', repoPath: '/broken', error: 'index.lock exists' }),
    ]);
    const errorGroup = groups[groups.length - 1];
    expect(errorGroup.group).toBe('error');
    expect(errorGroup.label).toBe('Repository Errors');
    expect(errorGroup.count).toBe(1);
    expect(errorGroup.repos).toEqual([
      { kind: 'repo', repoName: 'broken', repoPath: '/broken', branch: 'main', group: 'error', files: [], error: 'index.lock exists' },
    ]);
  });
  /* SNIPCODE-HOOK end */
});
