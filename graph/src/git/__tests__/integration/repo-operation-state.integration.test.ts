import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

describe('GitService integration — getRepoOperationState', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('returns "clean" on a normal repo with a commit', async () => {
    commit(repo.path, 'init', { 'a.txt': 'base\n' });
    expect(await svc.getRepoOperationState()).toBe('clean');
  });

  it('returns "merge" while a conflicting merge is in progress', async () => {
    commit(repo.path, 'init', { 'a.txt': 'base\n' });
    runGit(repo.path, ['checkout', '-b', 'left']);
    commit(repo.path, 'left', { 'a.txt': 'left\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'right', { 'a.txt': 'right\n' });

    // Conflicting merge parks MERGE_HEAD until resolved.
    await expect(svc.merge('left')).rejects.toThrow();
    expect(await svc.getRepoOperationState()).toBe('merge');
  });

  it('returns "bisect" while a bisect session is active', async () => {
    commit(repo.path, 'init', { 'a.txt': 'one\n' });
    runGit(repo.path, ['bisect', 'start']);
    expect(await svc.getRepoOperationState()).toBe('bisect');
    runGit(repo.path, ['bisect', 'reset']);
    expect(await svc.getRepoOperationState()).toBe('clean');
  });
});
