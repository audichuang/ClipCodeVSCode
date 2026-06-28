import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

describe('GitService integration — resolveDiffBaseRef', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('resolves a non-root commit to its first parent as a full SHA', async () => {
    const first = commit(repo.path, 'first', { 'a.txt': '1\n' });
    const second = commit(repo.path, 'second', { 'a.txt': '2\n' });

    const base = await svc.resolveDiffBaseRef(second);

    // A plain object name — no `~1` shorthand — that markdown-diff tools accept.
    expect(base).toBe(first);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolves a root commit (no parent) to the empty tree object', async () => {
    const root = commit(repo.path, 'root', { 'a.txt': '1\n' });
    const emptyTree = runGit(repo.path, ['mktree'], '').trim();

    const base = await svc.resolveDiffBaseRef(root);

    expect(base).toBe(emptyTree);
  });
});
