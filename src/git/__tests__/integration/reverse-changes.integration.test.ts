import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit, writeFile } from './helpers';

// Two edits far enough apart (line 2 and line 14) that git keeps them in
// separate hunks rather than merging them.
const BASE_F = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED_F = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';
const BASE_G = 'one\ntwo\nthree\nfour\nfive\n';
const CHANGED_G = 'one\ntwo\nINSERTED-A\nINSERTED-B\nthree\nfour\nfive\n';
// Two edits close enough (line 2 and line 5) that git keeps them in ONE hunk,
// separated by context lines — two distinct change blocks within the hunk.
const BASE_H = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
const CHANGED_H = 'l1\nl2X\nl3\nl4\nl5X\nl6\nl7\nl8\n';

function read(repo: TempRepo, file: string): string {
  return readFileSync(join(repo.path, file), 'utf-8');
}

describe('GitService integration — reverseCommitChanges', () => {
  let repo: TempRepo;
  let svc: GitService;
  let hash: string;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE_F, 'g.txt': BASE_G, 'h.txt': BASE_H });
    // One commit touching three files: f.txt with two separated hunks, g.txt
    // with a single pure-addition hunk, h.txt with two change regions in one hunk.
    hash = commit(repo.path, 'change', { 'f.txt': CHANGED_F, 'g.txt': CHANGED_G, 'h.txt': CHANGED_H });
  });
  afterEach(() => repo.cleanup());

  it('reverses a whole file back to its pre-commit state in the working tree', async () => {
    await svc.reverseCommitChanges(hash, 'f.txt');
    expect(read(repo, 'f.txt')).toBe(BASE_F);
    // Lands as an unstaged working-tree change, not a commit.
    const status = runGit(repo.path, ['status', '--porcelain', 'f.txt']);
    expect(status.trim()).toBe('M f.txt');
    expect(runGit(repo.path, ['rev-parse', 'HEAD']).trim()).toBe(hash);
  });

  it('reverses a single hunk, leaving the other hunk intact', async () => {
    const diff = (await svc.showCommitDiff(hash, 'f.txt'))[0];
    expect(diff.hunks.length).toBe(2);
    // Hunk 0 covers "beta", hunk 1 covers "xi".
    await svc.reverseCommitChanges(hash, 'f.txt', { hunkIndex: 0 });

    const result = read(repo, 'f.txt');
    expect(result).toContain('\nbeta\n'); // hunk 0 reversed
    expect(result).toContain('\nxi2\n'); // hunk 1 untouched
  });

  it('reverses a whole hunk containing multiple change regions (reverses all of them)', async () => {
    // h.txt has two change regions (l2→l2X and l5→l5X) bundled into one hunk.
    const diff = (await svc.showCommitDiff(hash, 'h.txt'))[0];
    expect(diff.hunks.length).toBe(1);
    await svc.reverseCommitChanges(hash, 'h.txt', { hunkIndex: 0 });

    // Reversing the hunk restores BOTH regions, not just one.
    expect(read(repo, 'h.txt')).toBe(BASE_H);
  });

  it('reverses a single added line, leaving its sibling addition intact', async () => {
    const hunk = (await svc.showCommitDiff(hash, 'g.txt'))[0].hunks[0];
    const idxB = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'INSERTED-B');
    expect(idxB).toBeGreaterThanOrEqual(0);

    await svc.reverseCommitChanges(hash, 'g.txt', { hunkIndex: 0, lineIndices: [idxB] });

    const result = read(repo, 'g.txt');
    expect(result).toContain('INSERTED-A');
    expect(result).not.toContain('INSERTED-B');
  });

  it('reverses a 2-line selection, leaving the rest of the hunk intact', async () => {
    const hunk = (await svc.showCommitDiff(hash, 'g.txt'))[0].hunks[0];
    const idxA = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'INSERTED-A');
    const idxB = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'INSERTED-B');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);

    // Both inserted lines selected → reversing them restores the original file.
    await svc.reverseCommitChanges(hash, 'g.txt', { hunkIndex: 0, lineIndices: [idxA, idxB] });
    expect(read(repo, 'g.txt')).toBe(BASE_G);
  });

  it('reverses a selected region of a multi-region hunk, leaving the other region intact', async () => {
    // h.txt's single hunk has two regions (l2→l2X and l5→l5X). Select only the
    // first region's modify pair (the delete + its following add).
    const hunk = (await svc.showCommitDiff(hash, 'h.txt'))[0].hunks[0];
    const delIdx = hunk.lines.findIndex((l) => l.type === 'delete');
    expect(hunk.lines[delIdx + 1].type).toBe('add');

    await svc.reverseCommitChanges(hash, 'h.txt', { hunkIndex: 0, lineIndices: [delIdx, delIdx + 1] });

    const result = read(repo, 'h.txt');
    expect(result).toContain('\nl2\n');  // first region reversed
    expect(result).not.toContain('l2X');
    expect(result).toContain('\nl5X\n'); // second region untouched
  });

  it('reverses the addition of a file created by the commit (deletes it)', async () => {
    const added = commit(repo.path, 'add new', { 'new.txt': 'fresh\n' });
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(true);
    await svc.reverseCommitChanges(added, 'new.txt');
    // Reversing a file-creation diff removes the file from the working tree.
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(false);
  });

  it('reverses the whole hunk of a newly-created file, deleting it', async () => {
    // Reversing every line of a wholly-added file's hunk is equivalent to
    // reversing the file: the `new file mode` header reverse-applies to a delete.
    const added = commit(repo.path, 'add multi', { 'created.txt': 'a\nb\nc\n' });
    await svc.reverseCommitChanges(added, 'created.txt', { hunkIndex: 0 });
    expect(existsSync(join(repo.path, 'created.txt'))).toBe(false);
  });

  it('reverses one added line of a newly-created file, keeping the rest', async () => {
    const added = commit(repo.path, 'add multi', { 'created.txt': 'a\nb\nc\n' });
    const hunk = (await svc.showCommitDiff(added, 'created.txt'))[0].hunks[0];
    const idxB = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'b');
    expect(idxB).toBeGreaterThanOrEqual(0);

    await svc.reverseCommitChanges(added, 'created.txt', { hunkIndex: 0, lineIndices: [idxB] });

    // The file survives with only the unselected lines — the whole-file-add
    // header is rewritten to a modification so the partial reverse applies.
    expect(existsSync(join(repo.path, 'created.txt'))).toBe(true);
    expect(read(repo, 'created.txt')).toBe('a\nc\n');
  });

  it('reverses the whole hunk of a deleted file, restoring it', async () => {
    commit(repo.path, 'seed', { 'gone.txt': 'p\nq\nr\n' });
    runGit(repo.path, ['rm', 'gone.txt']);
    const del = commit(repo.path, 'remove gone');
    expect(existsSync(join(repo.path, 'gone.txt'))).toBe(false);

    await svc.reverseCommitChanges(del, 'gone.txt', { hunkIndex: 0 });
    expect(read(repo, 'gone.txt')).toBe('p\nq\nr\n');
  });

  it('reverses one deleted line of a deleted file, recreating it with just that line', async () => {
    commit(repo.path, 'seed', { 'gone.txt': 'p\nq\nr\n' });
    runGit(repo.path, ['rm', 'gone.txt']);
    const del = commit(repo.path, 'remove gone');

    const hunk = (await svc.showCommitDiff(del, 'gone.txt'))[0].hunks[0];
    const idxQ = hunk.lines.findIndex((l) => l.type === 'delete' && l.content === 'q');
    expect(idxQ).toBeGreaterThanOrEqual(0);

    // Restoring only `q`'s deletion recreates the file holding just that line;
    // the `deleted file mode` header still reverse-applies to a create.
    await svc.reverseCommitChanges(del, 'gone.txt', { hunkIndex: 0, lineIndices: [idxQ] });
    expect(read(repo, 'gone.txt')).toBe('q\n');
  });

  it('throws when the file was not changed by the commit', async () => {
    await expect(svc.reverseCommitChanges(hash, 'does-not-exist.txt')).rejects.toThrow();
  });

  it('reverses a change introduced by the root commit (diffs against the empty tree)', async () => {
    // The root commit has no parent, so its diff is taken against the empty tree
    // via `git show`. Use a fresh repo whose root commit is still HEAD so the
    // reverse applies cleanly; reversing the root's addition removes the file.
    const rootRepo = createTempRepo();
    try {
      const rootSvc = new GitService(rootRepo.path);
      const root = commit(rootRepo.path, 'root', { 'r.txt': 'one\ntwo\n' });
      expect(existsSync(join(rootRepo.path, 'r.txt'))).toBe(true);

      await rootSvc.reverseCommitChanges(root, 'r.txt');
      expect(existsSync(join(rootRepo.path, 'r.txt'))).toBe(false);
    } finally {
      rootRepo.cleanup();
    }
  });
});

// A merge commit has 2+ parents, so the diff is taken against the first parent
// whose change for the file is non-empty (mirroring showCommitDiff).
describe('GitService integration — reverseCommitChanges on a merge commit', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  // Builds: main(base → main work) and feature(base → feature work), then an
  // "evil merge" that ALSO edits m.txt while merging. The merge commit's diff
  // for m.txt against its first parent (main work) is therefore non-empty.
  function buildEvilMerge(): string {
    commit(repo.path, 'base', { 'm.txt': 'x\n', 'side.txt': 's\n' });
    runGit(repo.path, ['checkout', '-b', 'feature']);
    commit(repo.path, 'feature work', { 'feature.txt': 'f\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'main work', { 'main.txt': 'mm\n' });
    runGit(repo.path, ['merge', '--no-ff', '--no-commit', 'feature']);
    writeFile(repo.path, 'm.txt', 'x\ny\n'); // change folded into the merge itself
    runGit(repo.path, ['add', '-A']);
    runGit(repo.path, ['commit', '--no-edit']);
    return head(repo.path);
  }

  it('reverses a change made by the merge commit itself', async () => {
    const mergeHash = buildEvilMerge();
    expect(runGit(repo.path, ['rev-list', '--parents', '-n1', mergeHash]).trim().split(' ').length).toBe(3);

    await svc.reverseCommitChanges(mergeHash, 'm.txt');
    // The merge added the `y` line; reversing restores the first parent's content.
    expect(read(repo, 'm.txt')).toBe('x\n');
  });

  it('throws for a file the merge left identical to both parents', async () => {
    const mergeHash = buildEvilMerge();
    // side.txt is unchanged everywhere, so every parent diff is empty.
    await expect(svc.reverseCommitChanges(mergeHash, 'side.txt')).rejects.toThrow(/No changes to reverse/);
  });

  // Regression: parent selection must agree between the displayed diff and the
  // reversed patch. The first parent's diff for m.txt is mode-only (non-empty
  // raw, but ZERO hunks); the second parent's carries the real content hunk.
  // Selecting on raw-non-emptiness would pick parent 1 and reverse the wrong
  // (mode) change / throw "Hunk 0 not found"; selecting on parsed hunks (as
  // showCommitDiff does) picks parent 2 — both paths must land on parent 2.
  function buildHunklessFirstParentMerge(): string {
    commit(repo.path, 'base', { 'm.txt': 'x\n' });
    runGit(repo.path, ['checkout', '-b', 'feature']);
    commit(repo.path, 'feature content', { 'm.txt': 'y\n' }); // real content change
    runGit(repo.path, ['checkout', 'main']); // main stays at base for m.txt
    runGit(repo.path, ['merge', '--no-ff', '--no-commit', 'feature']);
    // Resolve to base's CONTENT but flip the executable bit, so vs parent 1
    // (main = base) only the mode differs, while vs parent 2 (feature) the
    // content differs. update-index sets the recorded mode regardless of
    // core.fileMode, keeping the diff deterministic.
    writeFile(repo.path, 'm.txt', 'x\n');
    runGit(repo.path, ['add', '-A']);
    runGit(repo.path, ['update-index', '--chmod=+x', 'm.txt']);
    runGit(repo.path, ['commit', '--no-edit']);
    return head(repo.path);
  }

  it('reverses against the same parent the UI shows when an earlier parent is hunkless', async () => {
    const mergeHash = buildHunklessFirstParentMerge();

    // The displayed diff comes from parent 2 (the content-bearing parent).
    const diff = await svc.showCommitDiff(mergeHash, 'm.txt');
    expect(diff[0].hunks.length).toBeGreaterThan(0);
    const hunk = diff[0].hunks[0];
    expect(hunk.lines.some((l) => l.type === 'delete' && l.content === 'y')).toBe(true);
    expect(hunk.lines.some((l) => l.type === 'add' && l.content === 'x')).toBe(true);

    // Reversing hunk 0 must use that SAME parent — restoring feature's content.
    // Against the hunkless first parent this would throw "Hunk 0 not found".
    await svc.reverseCommitChanges(mergeHash, 'm.txt', { hunkIndex: 0 });
    expect(read(repo, 'm.txt')).toBe('y\n');
  });
});

// Files WITHOUT a trailing newline exercise the "\ No newline at end of file"
// marker handling in the patch builder. These read raw bytes so the assertions
// distinguish a present vs. absent trailing newline.
describe('GitService integration — reverseCommitChanges with no-trailing-newline files', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  function readBytes(file: string): string {
    return readFileSync(join(repo.path, file), 'utf-8');
  }

  // Helper: commit `before` then `after` (both written verbatim, no normalization),
  // returning the SHA of the second commit.
  function commitPair(file: string, before: string, after: string): string {
    commit(repo.path, 'base', { [file]: before });
    return commit(repo.path, 'change', { [file]: after });
  }

  it('Scenario A: reverses only the last added line, restoring "a\\nP" with no trailing newline', async () => {
    // old `a` (no EOF nl) → new `a\nP\nQ` (no EOF nl). Reverse only `Q`.
    const hash = commitPair('f', 'a', 'a\nP\nQ');
    const hunk = (await svc.showCommitDiff(hash, 'f'))[0].hunks[0];
    const idxQ = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'Q');
    expect(idxQ).toBeGreaterThanOrEqual(0);

    await svc.reverseCommitChanges(hash, 'f', { hunkIndex: 0, lineIndices: [idxQ] });

    // Must be exactly "a\nP" — NOT "a\nP\n" (the old bug gained a trailing newline).
    expect(readBytes('f')).toBe('a\nP');
  });

  it('Scenario B: reverses only the deleted line, restoring it on its own line without fusing', async () => {
    // old `X\nold` (no EOF nl) → new `X\nnew1\nnew2` (no EOF nl). Reverse only `old`.
    const hash = commitPair('f', 'X\nold', 'X\nnew1\nnew2');
    const hunk = (await svc.showCommitDiff(hash, 'f'))[0].hunks[0];
    const idxOld = hunk.lines.findIndex((l) => l.type === 'delete' && l.content === 'old');
    expect(idxOld).toBeGreaterThanOrEqual(0);

    await svc.reverseCommitChanges(hash, 'f', { hunkIndex: 0, lineIndices: [idxOld] });

    // Must be "X\nold\nnew1\nnew2" — NOT "X\noldnew1\nnew2" (old bug fused old+new1).
    expect(readBytes('f')).toBe('X\nold\nnew1\nnew2');
  });

  it('reverses a whole no-newline hunk back to the pre-commit bytes', async () => {
    const hash = commitPair('f', 'a\ntail', 'A\ntail');
    await svc.reverseCommitChanges(hash, 'f');
    // Trailing newline absence is preserved through the round-trip.
    expect(readBytes('f')).toBe('a\ntail');
  });

  it('regression: a normal newline-terminated single-line reverse still works', async () => {
    // The common path — files DO end in a newline — must remain correct.
    const hash = commitPair('f', 'a\nb\n', 'a\nb\nc\n');
    const hunk = (await svc.showCommitDiff(hash, 'f'))[0].hunks[0];
    const idxC = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'c');
    expect(idxC).toBeGreaterThanOrEqual(0);

    await svc.reverseCommitChanges(hash, 'f', { hunkIndex: 0, lineIndices: [idxC] });

    expect(readBytes('f')).toBe('a\nb\n');
  });
});
