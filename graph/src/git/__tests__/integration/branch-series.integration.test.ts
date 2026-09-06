// SNIPCODE-HOOK: whole-file — real-git coverage for the "copy a whole branch,
// restore it as a new branch" pair (exportBranchSeries / applyBranchSeries).
// Two things are worth pinning here and neither is obvious:
//   1. the restore is a faithful replay, not a squashed dump — so the
//      assertions compare per-commit subjects and authors AND the final tree;
//   2. a partial series (with a base) and a self-contained one (from the root)
//      have genuinely different reach. The partial one CANNOT apply where its
//      base commit is missing, which is what the paste-side warning is for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, seedBranches } from './helpers';

describe('GitService integration — branch series copy/restore', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('round-trips a partial series onto a new branch, preserving each commit', async () => {
    const { featureBase } = seedBranches(repo.path); // main: 3 commits, feature: 2 more

    const { mbox, base, count } = await svc.exportBranchSeries('feature', featureBase);
    expect(count).toBe(2);
    expect(base).toBe(featureBase);
    // The trailer is what lets the paste side rebuild from the same start point.
    expect(mbox).toMatch(/^base-commit: [0-9a-f]{40}$/m);

    // The flow the feature exists for: restore beside main, never on top of it.
    await svc.createAndCheckoutBranch('restored', featureBase);
    await svc.applyBranchSeries(mbox);

    const fmt = '--format=%s|%an|%ae|%ad';
    expect(runGit(repo.path, ['log', fmt, '--reverse', `${featureBase}..HEAD`]).trim())
      .toBe(runGit(repo.path, ['log', fmt, '--reverse', `${featureBase}..feature`]).trim());
    // Identical trees — the replay is not just message-deep.
    expect(runGit(repo.path, ['diff', 'feature', 'HEAD']).trim()).toBe('');
    expect(runGit(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('restored');
  });

  it('restores a self-contained series into a repo that shares no history', async () => {
    seedBranches(repo.path);

    const { mbox, base, count } = await svc.exportBranchSeries('feature', null);
    expect(base).toBeNull();
    expect(count).toBe(4); // the whole history behind feature, back to the root
    expect(mbox).not.toMatch(/^base-commit:/m);

    const other = createTempRepo();
    try {
      const otherSvc = new GitService(other.path);
      commit(other.path, 'unrelated', { 'z.txt': 'z\n' }); // nothing in common
      await otherSvc.createOrphanBranch('imported');
      await otherSvc.applyBranchSeries(mbox);

      expect(runGit(other.path, ['log', '--format=%s', '--reverse']).trim().split('\n'))
        .toEqual(['init', 'main second', 'feature first', 'feature second']);
      expect(readFileSync(join(other.path, 'feature2.txt'), 'utf8')).toBe('f2\n');
    } finally {
      other.cleanup();
    }
  });

  it('cannot apply a partial series where the base commit is missing', async () => {
    // Justifies the paste-side warning: git needs the base blobs to rebuild the
    // ancestor, so an edit to a pre-existing file has nothing to apply against.
    seedBranches(repo.path);
    runGit(repo.path, ['checkout', '-q', 'feature']);
    commit(repo.path, 'feature edits an existing file', { 'a.txt': 'a changed\n' });
    const base = await svc.mergeBase('main', 'feature');
    const { mbox } = await svc.exportBranchSeries('feature', base);

    const other = createTempRepo();
    try {
      const otherSvc = new GitService(other.path);
      commit(other.path, 'unrelated', { 'z.txt': 'z\n' });
      await expect(otherSvc.applyBranchSeries(mbox)).rejects.toThrow();
    } finally {
      other.cleanup();
    }
  });

  it('finds the merge base, and reports null for unrelated histories', async () => {
    const { featureBase } = seedBranches(repo.path);
    await expect(svc.mergeBase('main', 'feature')).resolves.toBe(featureBase);

    await svc.createOrphanBranch('detached-history');
    commit(repo.path, 'unrelated root', { 'other.txt': 'o\n' });
    await expect(svc.mergeBase('main', 'detached-history')).resolves.toBeNull();
  });

  it('reports an empty series when the branch adds nothing over the base', async () => {
    commit(repo.path, 'init', { 'README.md': 'init\n' });
    runGit(repo.path, ['branch', 'sibling']);

    const { count, mbox } = await svc.exportBranchSeries('sibling', await svc.mergeBase('main', 'sibling'));
    expect(count).toBe(0);
    expect(mbox).toBe('');
  });

  it('distinguishes a base commit that exists here from one that does not', async () => {
    const sha = commit(repo.path, 'init', { 'README.md': 'init\n' });

    await expect(svc.hasCommit(sha)).resolves.toBe(true);
    await expect(svc.hasCommit('0'.repeat(40))).resolves.toBe(false);
  });

  it('sees a dirty working tree, which would make a restore fail mid-way', async () => {
    commit(repo.path, 'init', { 'README.md': 'init\n' });
    await expect(svc.isWorkingTreeClean()).resolves.toBe(true);

    runGit(repo.path, ['rm', '--cached', 'README.md']);
    await expect(svc.isWorkingTreeClean()).resolves.toBe(false);
  });
});
