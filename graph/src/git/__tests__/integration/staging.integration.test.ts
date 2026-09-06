import { describe, it, expect, beforeEach, afterEach } from 'vitest';
/* SNIPCODE-HOOK start: Batch B rename staging regression */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
/* SNIPCODE-HOOK end */
/* SNIPCODE-HOOK start: S4 discardPaths integration */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
/* SNIPCODE-HOOK end */
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

describe('GitService integration — real staging (stagePaths/unstagePaths/commitIndex)', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    // A committed baseline file so we can produce tracked modifications.
    commit(repo.path, 'baseline', { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  });
  afterEach(() => repo.cleanup());

  it('stagePaths moves a modified file from unstaged to staged', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    let diff = await svc.getUncommittedDiff();
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
    expect(diff.staged.map(e => e.path)).not.toContain('a.txt');

    await svc.stagePaths(['a.txt']);

    diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).toContain('a.txt');
  });

  it('stagePaths handles an untracked new file', async () => {
    writeFile(repo.path, 'new.txt', 'hi\n');
    await svc.stagePaths(['new.txt']);
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.find(e => e.path === 'new.txt')?.status).toBe('A');
  });

  it('unstagePaths moves a staged file back to unstaged (working change kept)', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']);
    await svc.unstagePaths(['a.txt']);
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).not.toContain('a.txt');
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
  });

  /* SNIPCODE-HOOK start: Batch B rename staging regression */
  it('threads both paths through stagePaths and unstagePaths for a rename', async () => {
    renameSync(join(repo.path, 'a.txt'), join(repo.path, 'renamed.txt'));
    const rename = { path: 'renamed.txt', oldPath: 'a.txt' };

    await svc.stagePaths([rename] as unknown as string[]);
    const staged = await svc.getUncommittedDiff();
    expect(staged.staged).toEqual([{ path: 'renamed.txt', oldPath: 'a.txt', status: 'R' }]);

    await svc.unstagePaths(staged.staged as unknown as string[]);
    expect(runGit(repo.path, ['diff', '--cached', '--name-status'])).toBe('');
  });
  /* SNIPCODE-HOOK end */

  it('MM: a file staged then edited again shows in BOTH groups', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']);
    writeFile(repo.path, 'a.txt', 'a3\n'); // further unstaged edit
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).toContain('a.txt');
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
  });

  it('commitIndex commits only staged, leaves the rest in the working tree, index clean', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    writeFile(repo.path, 'b.txt', 'b2\n');
    await svc.stagePaths(['a.txt']); // stage only a.txt

    const hash = await svc.commitIndex('修正 a 檔');

    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    // index is clean after commit
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged).toHaveLength(0);
    // b.txt is still an unstaged working change (was never staged/committed)
    expect(diff.unstaged.map(e => e.path)).toContain('b.txt');
    // the commit message landed
    expect(runGit(repo.path, ['log', '-1', '--format=%s']).trim()).toBe('修正 a 檔');
  });

  it('commitIndex throws when nothing is staged', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n'); // unstaged only
    await expect(svc.commitIndex('空提交')).rejects.toThrow(/nothing staged/i);
  });

  /* SNIPCODE-HOOK start: R3/S3 real merge conflict classification */
  it('a real merge conflict lands in `conflict`, not staged/unstaged, and stagePaths (Mark Resolved) clears it', async () => {
    runGit(repo.path, ['checkout', '-b', 'feature']);
    writeFile(repo.path, 'a.txt', 'from feature\n');
    runGit(repo.path, ['commit', '-am', 'feature edit']);
    runGit(repo.path, ['checkout', 'main']);
    writeFile(repo.path, 'a.txt', 'from main\n');
    runGit(repo.path, ['commit', '-am', 'main edit']);
    try {
      runGit(repo.path, ['merge', 'feature']);
    } catch { /* merge conflict exits non-zero — expected */ }

    const diff = await svc.getUncommittedDiff();
    expect(diff.conflict).toEqual([{ path: 'a.txt', status: '!' }]);
    expect(diff.staged.map(e => e.path)).not.toContain('a.txt');
    expect(diff.unstaged.map(e => e.path)).not.toContain('a.txt');

    // "Mark Resolved" = git add, same as stagePaths.
    await svc.stagePaths(['a.txt']);
    const afterResolve = await svc.getUncommittedDiff();
    expect(afterResolve.conflict).toEqual([]);
    expect(afterResolve.staged.map(e => e.path)).toContain('a.txt');
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S4 discardPaths integration */
  it('discardPaths reverts a tracked working-tree edit and leaves staged changes untouched', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n'); // unstaged edit
    writeFile(repo.path, 'b.txt', 'b2\n');
    await svc.stagePaths(['b.txt']); // b.txt is staged, must survive discard of a.txt

    await svc.discardPaths([{ path: 'a.txt', status: 'M' }]);

    expect(runGit(repo.path, ['status', '--porcelain']).trim()).toBe('M  b.txt');
    expect(runGit(repo.path, ['show', ':a.txt']).trim()).toBe('a1'); // back to HEAD content
  });

  it('discardPaths removes an untracked file from disk via git clean', async () => {
    writeFile(repo.path, 'new.txt', 'hi\n');
    await svc.discardPaths([{ path: 'new.txt', status: 'U' }]);

    const diff = await svc.getUncommittedDiff();
    expect(diff.unstaged).toEqual([]);
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(false);
  });

  it('discardPaths never runs git clean on a nested repo directory (status N)', async () => {
    const nestedRepo = createTempRepo();
    try {
      const nestedDirName = 'vendor-lib';
      mkdirSync(join(repo.path, nestedDirName), { recursive: true });
      // A .git dir marks it as its own repo — untracked, surfaces as status N.
      renameSync(join(nestedRepo.path, '.git'), join(repo.path, nestedDirName, '.git'));
      writeFile(repo.path, `${nestedDirName}/README.md`, 'nested\n');

      await svc.discardPaths([{ path: nestedDirName, status: 'N' }]);

      expect(existsSync(join(repo.path, nestedDirName, '.git'))).toBe(true);
    } finally {
      nestedRepo.cleanup();
    }
  });

  /* SNIPCODE-HOOK start: F1 discard must restore from the index, not HEAD */
  it('MM: discard reverts only the unstaged edit — worktree matches the INDEX version, index untouched', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']); // index now has a2 (staged edit)
    writeFile(repo.path, 'a.txt', 'a3\n'); // further unstaged edit on top

    await svc.discardPaths([{ path: 'a.txt', status: 'M' }]);

    // Worktree drops back to the staged (index) content, NOT the original
    // HEAD content — a `--source=HEAD` restore would wrongly land on 'a1'.
    expect(runGit(repo.path, ['show', ':a.txt']).trim()).toBe('a2');
    const worktreeContent = readFileSync(join(repo.path, 'a.txt'), 'utf-8');
    expect(worktreeContent).toBe('a2\n');
    // Staged change survives — discard is worktree-only.
    expect(runGit(repo.path, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
  });

  it('AM: discard on a staged-then-edited new file keeps the file, restored to the staged (index) content', async () => {
    writeFile(repo.path, 'new.txt', 'v1\n');
    await svc.stagePaths(['new.txt']); // staged add, absent from HEAD
    writeFile(repo.path, 'new.txt', 'v2\n'); // further unstaged edit

    await svc.discardPaths([{ path: 'new.txt', status: 'M' }]);

    // A `--source=HEAD` restore would delete this file (HEAD has no such
    // path) — the fix must leave it in place, at the staged content.
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(true);
    const worktreeContent = readFileSync(join(repo.path, 'new.txt'), 'utf-8');
    expect(worktreeContent).toBe('v1\n');
    expect(runGit(repo.path, ['diff', '--cached', '--name-only']).trim()).toBe('new.txt');
  });

  it('staged-only (M in index, clean worktree): discard is a no-op', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']); // staged, worktree already matches index

    await svc.discardPaths([{ path: 'a.txt', status: 'M' }]);

    expect(runGit(repo.path, ['show', ':a.txt']).trim()).toBe('a2');
    const worktreeContent = readFileSync(join(repo.path, 'a.txt'), 'utf-8');
    expect(worktreeContent).toBe('a2\n');
    expect(runGit(repo.path, ['status', '--porcelain']).trim()).toBe('M  a.txt');
  });
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

  it('unstagePaths under an unborn HEAD (no commits) unstages via rm --cached', async () => {
    const fresh = createTempRepo();
    try {
      const s = new GitService(fresh.path);
      writeFile(fresh.path, 'x.txt', 'x\n');
      await s.stagePaths(['x.txt']);
      await s.unstagePaths(['x.txt']); // must not throw despite no HEAD
      const diff = await s.getUncommittedDiff();
      expect(diff.staged).toHaveLength(0);
      expect(diff.unstaged.find(e => e.path === 'x.txt')?.status).toBe('U');
    } finally {
      fresh.cleanup();
    }
  });
});
