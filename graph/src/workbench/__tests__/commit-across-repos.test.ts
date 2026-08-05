import { describe, it, expect, vi } from 'vitest';
import { commitAcrossRepos, type CommitAcrossReposDeps } from '../commit-across-repos';

// Real serialization semantics without the git layer: same as mutation-coordinator
// but inline so the test asserts ordering deterministically.
const passthroughExclusive = <T>(_repo: string, fn: () => Promise<T>) => fn();

describe('commitAcrossRepos', () => {
  it('commits every selected repo and returns per-repo new heads', async () => {
    const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
    const results = await commitAcrossRepos(
      { runExclusive: passthroughExclusive, commitSelected },
      '修正手續費計算',
      [
        { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 2 }] },
        { repoPath: '/b', files: [{ path: 'y.ts', hunkCount: 1 }] },
      ],
    );
    expect(results).toEqual([
      { repoPath: '/a', ok: true, newHead: 'head-/a' },
      { repoPath: '/b', ok: true, newHead: 'head-/b' },
    ]);
    // Whole-file expansion: hunkCount 2 → [0,1]; 1 → [0].
    expect(commitSelected).toHaveBeenCalledWith('/a', '修正手續費計算', [{ path: 'x.ts', hunkIndices: [0, 1] }], undefined);
    expect(commitSelected).toHaveBeenCalledWith('/b', '修正手續費計算', [{ path: 'y.ts', hunkIndices: [0] }], undefined);
  });

  it('refuses amend spanning multiple repos before any commit runs (host-side D-guard)', async () => {
    const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
    await expect(
      commitAcrossRepos(
        { runExclusive: passthroughExclusive, commitSelected },
        'reword',
        [
          { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 1 }] },
          { repoPath: '/b', files: [{ path: 'y.ts', hunkCount: 1 }] },
        ],
        { amend: true },
      ),
    ).rejects.toThrow('amend can only target a single repo');
    // No repo's HEAD was rewritten.
    expect(commitSelected).not.toHaveBeenCalled();
  });

  it('allows amend for a single repo', async () => {
    const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
    const results = await commitAcrossRepos(
      { runExclusive: passthroughExclusive, commitSelected },
      'reword',
      [{ repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 1 }] }],
      { amend: true },
    );
    expect(results).toEqual([{ repoPath: '/a', ok: true, newHead: 'head-/a' }]);
    expect(commitSelected).toHaveBeenCalledWith('/a', 'reword', [{ path: 'x.ts', hunkIndices: [0] }], { amend: true });
  });

  it('reports a per-repo failure without failing or re-committing the others', async () => {
    const commitSelected = vi.fn(async (repo: string) => {
      if (repo === '/b') throw new Error('pre-commit hook failed');
      return `head-${repo}`;
    });
    const results = await commitAcrossRepos(
      { runExclusive: passthroughExclusive, commitSelected },
      'msg',
      [
        { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 1 }] },
        { repoPath: '/b', files: [{ path: 'y.ts', hunkCount: 1 }] },
      ],
    );
    expect(results).toEqual([
      { repoPath: '/a', ok: true, newHead: 'head-/a' },
      { repoPath: '/b', ok: false, error: 'pre-commit hook failed' },
    ]);
    // /a committed exactly once — a retry must not double-commit it.
    expect(commitSelected).toHaveBeenCalledTimes(2);
  });

  it('wraps each repo commit in runExclusive keyed by repo path', async () => {
    // vitest's Mock<T> can't stay generic across calls (T collapses to unknown),
    // so the mock itself is untyped and cast to the deps shape at the call site.
    const runExclusive = vi.fn((_repo: string, fn: () => Promise<unknown>) => fn());
    const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
    const deps: CommitAcrossReposDeps = {
      runExclusive: runExclusive as CommitAcrossReposDeps['runExclusive'],
      commitSelected,
    };
    await commitAcrossRepos(deps, 'm', [{ repoPath: '/a', files: [{ path: 'x', hunkCount: 1 }] }]);
    expect(runExclusive).toHaveBeenCalledWith('/a', expect.any(Function));
  });

  it('passes amend through to commitSelected', async () => {
    const commitSelected = vi.fn(async () => 'h');
    await commitAcrossRepos({ runExclusive: passthroughExclusive, commitSelected }, 'm',
      [{ repoPath: '/a', files: [{ path: 'x', hunkCount: 1 }] }], { amend: true });
    expect(commitSelected).toHaveBeenCalledWith('/a', 'm', [{ path: 'x', hunkIndices: [0] }], { amend: true });
  });
});
