import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

// Two edit sites far apart (line 2 and line 14) so git keeps them in two
// separate hunks. hunk 0 = beta→beta2, hunk 1 = xi→xi2.
const BASE = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';

describe('GitService integration — stageHunks / unstageHunks', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    writeFile(repo.path, 'f.txt', CHANGED); // two unstaged hunks, nothing staged
  });
  afterEach(() => repo.cleanup());

  it('stageHunks([0]) stages only hunk 0, leaving hunk 1 unstaged (MM)', async () => {
    await svc.stageHunks('f.txt', [0]);

    // Index holds hunk 0 (beta2) but NOT hunk 1 (xi2).
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+beta2');
    expect(cached).not.toContain('+xi2');

    // The file is now BOTH staged (hunk 0) and unstaged (hunk 1): porcelain MM.
    // Porcelain format is "XY path" — slice the 2-char status code off, since
    // .trim() alone would leave the trailing filename in the string.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');

    // The working tree is untouched — still carries both edits.
    const wt = runGit(repo.path, ['show', ':f.txt']); // index version has hunk0 only
    expect(wt).toContain('\nbeta2\n');
    expect(wt).toContain('\nxi\n'); // index still has old xi (hunk1 not staged)
  });

  it('unstageHunks([0]) unstages only hunk 0, leaving hunk 1 staged (MM)', async () => {
    // Stage the whole file first (both hunks in the index).
    runGit(repo.path, ['add', 'f.txt']);
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('M ');

    await svc.unstageHunks('f.txt', [0]);

    // Index keeps hunk 1 (xi2) but NOT hunk 0 (beta2).
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+xi2');
    expect(cached).not.toContain('+beta2');

    // hunk 0 is now unstaged again while hunk 1 stays staged: porcelain MM.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');
  });

  it('stageHunks throws when the file has no unstaged changes', async () => {
    runGit(repo.path, ['checkout', '--', 'f.txt']); // discard working edits
    await expect(svc.stageHunks('f.txt', [0])).rejects.toThrow(/no unstaged changes/);
  });

  it('unstageHunks throws when the file has no staged changes', async () => {
    await expect(svc.unstageHunks('f.txt', [0])).rejects.toThrow(/no staged changes/);
  });

  it('stageHunks refuses a file that also has a mode change (avoids staging an unopted chmod)', async () => {
    // A working-tree mode change makes `git diff` carry `old mode`/`new mode` in
    // the header, which per-hunk staging would apply alongside a content hunk.
    chmodSync(join(repo.path, 'f.txt'), 0o755);
    const raw = runGit(repo.path, ['diff', 'f.txt']);
    // Precondition: this repo actually records file mode (core.filemode on).
    if (!/^new mode /m.test(raw)) { return; }
    await expect(svc.stageHunks('f.txt', [0])).rejects.toThrow(/mode or rename/);
  });
});
