// SNIPCODE-HOOK: whole-file — real-git coverage for aheadBehind(), the data
// behind the Changes tree's `main ↓3 ↑1` badges. Uses a LOCAL branch as the
// upstream (git allows --set-upstream-to onto a plain local branch) so no
// network or bare remote is needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

describe('GitService integration — aheadBehind', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': 'v1\n' });
  });
  afterEach(() => repo.cleanup());

  it('reports ahead and behind against the upstream', async () => {
    runGit(repo.path, ['branch', 'upstream-branch']);
    // Diverge: 2 commits on main (ahead), 1 on upstream-branch (behind).
    commit(repo.path, 'main a', { 'a.txt': 'a\n' });
    commit(repo.path, 'main b', { 'b.txt': 'b\n' });
    runGit(repo.path, ['checkout', '-q', 'upstream-branch']);
    commit(repo.path, 'upstream only', { 'u.txt': 'u\n' });
    runGit(repo.path, ['checkout', '-q', '-']);
    runGit(repo.path, ['branch', '--set-upstream-to=upstream-branch']);

    await expect(svc.aheadBehind()).resolves.toEqual({ ahead: 2, behind: 1 });
  });

  it('returns zeros when fully in sync with the upstream', async () => {
    runGit(repo.path, ['branch', 'upstream-branch']);
    runGit(repo.path, ['branch', '--set-upstream-to=upstream-branch']);
    await expect(svc.aheadBehind()).resolves.toEqual({ ahead: 0, behind: 0 });
  });

  it('returns null without an upstream and on a detached HEAD', async () => {
    await expect(svc.aheadBehind()).resolves.toBeNull(); // no upstream configured
    runGit(repo.path, ['checkout', '-q', '--detach']);
    await expect(svc.aheadBehind()).resolves.toBeNull();
  });
});
