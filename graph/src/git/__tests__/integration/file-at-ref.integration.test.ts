// SNIPCODE-HOOK: whole-file — real-git coverage for getFileAtRef, the content
// source of the Diff tab's "open full file diff in editor" view. This path
// failed in the field once (as a git:-URI dependency); keep it pinned to git.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

describe('GitService integration — getFileAtRef', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': 'committed\n' });
  });
  afterEach(() => repo.cleanup());

  it("serves HEAD and index ('' ref) versions distinctly", async () => {
    writeFile(repo.path, 'f.txt', 'staged\n');
    runGit(repo.path, ['add', 'f.txt']);
    writeFile(repo.path, 'f.txt', 'working\n'); // working differs from both

    await expect(svc.getFileAtRef('HEAD', 'f.txt')).resolves.toBe('committed\n');
    await expect(svc.getFileAtRef('', 'f.txt')).resolves.toBe('staged\n');
  });

  it('throws for a file absent at the ref (new file at HEAD)', async () => {
    writeFile(repo.path, 'new.txt', 'brand new\n');
    runGit(repo.path, ['add', 'new.txt']);
    await expect(svc.getFileAtRef('', 'new.txt')).resolves.toBe('brand new\n');
    await expect(svc.getFileAtRef('HEAD', 'new.txt')).rejects.toThrow();
  });

  it('rejects unsafe refs and paths', async () => {
    await expect(svc.getFileAtRef('--output=/tmp/x', 'f.txt')).rejects.toThrow();
    await expect(svc.getFileAtRef('HEAD', '../escape.txt')).rejects.toThrow();
  });
});
