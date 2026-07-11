import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
