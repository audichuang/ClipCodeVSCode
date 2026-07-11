import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit, writeFile } from './helpers';

// Base with two edit sites far apart (line 2 and line 14) so git keeps them in
// two separate hunks; only the working tree is changed (not committed).
const BASE = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';

describe('GitService integration — commitSelected', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    // Working-tree edit only (two hunks), left uncommitted and unstaged.
    writeFile(repo.path, 'f.txt', CHANGED);
  });
  afterEach(() => repo.cleanup());

  it('commits only the selected hunk, leaving the other hunk in the working tree and the index clean', async () => {
    const before = head(repo.path);
    const newHash = await svc.commitSelected('只提交第一個 hunk', [{ path: 'f.txt', hunkIndices: [0] }]);

    // A new commit was created and returned.
    expect(newHash).not.toBe(before);
    expect(newHash).toBe(head(repo.path));

    // The commit contains hunk 0 (beta→beta2) but NOT hunk 1 (xi→xi2).
    const committed = runGit(repo.path, ['show', 'HEAD:f.txt']);
    expect(committed).toContain('\nbeta2\n');
    expect(committed).toContain('\nxi\n');
    expect(committed).not.toContain('\nxi2\n');

    // Hunk 1 is still an unstaged working-tree change.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('M f.txt');

    // Index is clean (== HEAD): `git diff --cached --quiet` exits 0.
    expect(() => runGit(repo.path, ['diff', '--cached', '--quiet'])).not.toThrow();
  });

  it('D1: refuses to commit when the index already has staged changes', async () => {
    // Dirty the index with an unrelated staged file.
    writeFile(repo.path, 'other.txt', 'staged\n');
    runGit(repo.path, ['add', 'other.txt']);

    await expect(
      svc.commitSelected('should not run', [{ path: 'f.txt', hunkIndices: [0] }]),
    ).rejects.toThrow('index already has staged changes');
  });

  it('D4: refuses to commit while a merge is in progress', async () => {
    // Build a conflicting merge so MERGE_HEAD is parked.
    runGit(repo.path, ['checkout', '-b', 'left']);
    commit(repo.path, 'left', { 'g.txt': 'left\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'right', { 'g.txt': 'right\n' });
    // Recreate the conflicting content on both sides to force a real conflict.
    runGit(repo.path, ['checkout', '-b', 'left2', 'left']);
    writeFile(repo.path, 'g.txt', 'left-conflict\n');
    runGit(repo.path, ['commit', '-am', 'left conflict']);
    runGit(repo.path, ['checkout', 'main']);
    writeFile(repo.path, 'g.txt', 'main-conflict\n');
    runGit(repo.path, ['commit', '-am', 'main conflict']);
    expect(() => runGit(repo.path, ['merge', 'left2'])).toThrow();

    await expect(
      svc.commitSelected('should not run', [{ path: 'f.txt', hunkIndices: [0] }]),
    ).rejects.toThrow('in-progress merge');
  });
});
