import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

// A single hunk with two adjacent changed lines so `lineIndices` selects a
// subset WITHIN one hunk (unlike hunk-staging which selects whole hunks).
//   base:    L1 / A / B / L4
//   changed: L1 / A2 / B2 / L4   → one hunk: -A -B +A2 +B2 (indices 1,2,3,4)
// NOTE: real `git diff` groups all deletions before all additions (it does not
// interleave del/add pairs), so the hunk body is ctx,del,del,add,add,ctx — not
// the del/add/del/add layout the plan draft assumed. Indices below reflect the
// REAL git diff output (ponytail: verified against actual `git diff`, not guessed).
const BASE = 'L1\nA\nB\nL4\n';
const CHANGED = 'L1\nA2\nB2\nL4\n';

describe('GitService integration — stageLines / unstageLines', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    writeFile(repo.path, 'f.txt', CHANGED); // one unstaged hunk, nothing staged
  });
  afterEach(() => repo.cleanup());

  it('stages only the A→A2 change, leaving B→B2 unstaged', async () => {
    // The hunk parses as: 0 ctx L1, 1 del A, 2 del B, 3 add A2, 4 add B2, 5 ctx L4.
    // Stage just the A→A2 lines (del A at 1, add A2 at 3).
    await svc.stageLines('f.txt', 0, [1, 3]);

    // Index now has A2 but NOT B2.
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+A2');
    expect(cached).not.toContain('+B2');

    // The index blob must keep A2 in A's original slot (line order pinned) —
    // not just "contains A2 and B somewhere" (that also passes on the
    // pre-523e96f swapped-order regression: L1/B/A2/L4).
    const indexBlob = runGit(repo.path, ['show', ':f.txt']);
    expect(indexBlob).toBe('L1\nA2\nB\nL4\n');

    // The working tree is untouched — still has both edits.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');
  });

  it('unstages only the A→A2 change, leaving B→B2 staged', async () => {
    runGit(repo.path, ['add', 'f.txt']); // stage the whole file (both changes)
    await svc.unstageLines('f.txt', 0, [1, 3]);

    // Index keeps B2 but drops A2 back to unstaged.
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+B2');
    expect(cached).not.toContain('+A2');

    // Exact blob, order pinned (same regression this guards as the stage test).
    const indexBlob = runGit(repo.path, ['show', ':f.txt']);
    expect(indexBlob).toBe('L1\nA\nB2\nL4\n');

    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');
  });

  it('stages a subset of a file that ends without a trailing newline', async () => {
    // no-EOF file: base "P\nQ" (no final newline) → working "P2\nQ2" (no final
    // newline). Stage only P→P2. Must apply cleanly and keep Q's original value
    // in the index, still unterminated.
    commit(repo.path, 'noeof-base', { 'g.txt': 'P\nQ' });   // no trailing newline
    writeFile(repo.path, 'g.txt', 'P2\nQ2');                 // no trailing newline
    // Hunk: 0 del P, 1 del Q, 2 add P2, 3 add Q2. Stage P→P2 (del P at 0, add P2 at 2).
    await svc.stageLines('g.txt', 0, [0, 2]);
    const cached = runGit(repo.path, ['diff', '--cached', 'g.txt']);
    expect(cached).toContain('+P2');
    expect(cached).not.toContain('+Q2');
    const indexBlob = runGit(repo.path, ['show', ':g.txt']);
    expect(indexBlob).toBe('P2\nQ'); // P2 staged, Q unchanged, still no trailing newline
  });

  it('unstages a subset when HEAD lacks a trailing newline but the index has one (mixed EOF)', async () => {
    // HEAD: 'P\nQ' with NO trailing newline. Both lines are then changed and
    // staged as 'P2\nQ2\n' WITH a trailing newline. Unstage only P→P2 — the hunk
    // (HEAD→index) is: 0 del P, 1 del Q (HEAD has no eof → marker on Q),
    // 2 add P2, 3 add Q2. Q2 must stay staged, untouched, with its OWN (real)
    // trailing newline — it must not inherit HEAD's no-trailing-newline state.
    commit(repo.path, 'mixed-eof-base', { 'h.txt': 'P\nQ' }); // no trailing newline
    writeFile(repo.path, 'h.txt', 'P2\nQ2\n'); // trailing newline
    runGit(repo.path, ['add', 'h.txt']);
    await svc.unstageLines('h.txt', 0, [0, 2]);
    const indexBlob = runGit(repo.path, ['show', ':h.txt']);
    expect(indexBlob).toBe('P\nQ2\n'); // P reverted to HEAD; Q2 stays staged with its real trailing newline
  });

  it('unstages only a trailing no-newline add, keeping an earlier unselected add staged (old-side split)', async () => {
    // HEAD: 'X\n'. Staged: 'X\nA\nB' with NO trailing newline (marker on B).
    // Unstage ONLY B; A is unselected → stays staged (demoted to context). The
    // reconstructed old side then ends at A (a shared context line) while a
    // kept new-only addition (B) still follows it in the patch body — the
    // no-newline marker must land on that shared A line without truncating the
    // '+B' that comes after (the old-side mirror of the existing new-side split).
    commit(repo.path, 'split-base', { 'k.txt': 'X\n' });
    writeFile(repo.path, 'k.txt', 'X\nA\nB'); // no trailing newline
    runGit(repo.path, ['add', 'k.txt']);
    await svc.unstageLines('k.txt', 0, [2]); // hunk: 0 ctx X, 1 add A, 2 add B(marker)
    const indexBlob = runGit(repo.path, ['show', ':k.txt']);
    expect(indexBlob).toBe('X\nA'); // B unstaged; A stays, taking on the no-newline tail
  });

  it('throws when the file has no unstaged changes', async () => {
    runGit(repo.path, ['checkout', '--', 'f.txt']);
    await expect(svc.stageLines('f.txt', 0, [1, 2])).rejects.toThrow(/no unstaged changes/);
  });

  it('throws when the file has no staged changes', async () => {
    await expect(svc.unstageLines('f.txt', 0, [1, 2])).rejects.toThrow(/no staged changes/);
  });
});
