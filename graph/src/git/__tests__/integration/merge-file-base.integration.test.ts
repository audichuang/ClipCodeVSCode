/* SNIPCODE-HOOK start: whole-file — per-file merge parent for the native diff
   editor (`resolveCommitFileBases`).

   `showCommitFiles` returns the UNION of a merge's diffs against every parent,
   but `resolveDiffBaseRef` only ever names the FIRST one. Every caller that
   opens a native diff editor (MainPanel's graph row, the Recent Commits
   sidebar) paired the two, so a file that arrived from parent 2..N opened as an
   empty diff, and a file one side renamed had its left blob looked up under a
   path the winning parent doesn't know.

   Real git, no mocks: the repo below is built so that against the FIRST parent
   the file is a rename with identical blobs (a "there is nothing here" diff)
   while the content change lives on the SECOND. That is exactly the shape the
   private commitFileDiff already walks parents for, and these tests pin the two
   resolutions to the same parent so they cannot drift apart. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

// Long enough that git pairs the rename comfortably above the default 50%
// similarity threshold even though one side also edited the content.
const BASE = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';

let repo: TempRepo;
let git: GitService;

beforeEach(() => {
  repo = createTempRepo();
  git = new GitService(repo.path);
});
afterEach(() => repo.cleanup());

/** Does `file` actually change content between `parent` and `hash`? */
function hasContentChange(repoPath: string, parent: string, hash: string, file: string, oldPath?: string): boolean {
  const args = ['diff', '--raw', '-M', '--no-abbrev', `${parent}..${hash}`, '--'];
  if (oldPath) args.push(oldPath);
  args.push(file);
  return runGit(repoPath, args)
    .split('\n')
    .filter(Boolean)
    .some(line => {
      const fields = line.slice(1).split(' ');
      return fields[2] !== fields[3];
    });
}

describe('resolveCommitFileBases (merge parents)', () => {
  /**
   * base ── main: edits a.txt
   *    └──── side: renames a.txt → renamed.txt, edits b.txt
   * merge: renamed.txt is a pure rename vs main (identical blob) but a real
   * content change vs side; b.txt changed only on side.
   */
  function mergeRepo(): { merge: string; first: string; second: string } {
    commit(repo.path, 'base', { 'a.txt': BASE, 'b.txt': 'b-base\n' });
    runGit(repo.path, ['checkout', '-b', 'side']);
    runGit(repo.path, ['mv', 'a.txt', 'renamed.txt']);
    const second = commit(repo.path, 'side: rename + edit b', { 'b.txt': 'b-side\n' });
    runGit(repo.path, ['checkout', 'main']);
    const first = commit(repo.path, 'main: edit a', { 'a.txt': BASE + 'export const extra = true;\n' });
    runGit(repo.path, ['merge', 'side', '-m', 'merge side']);
    return { merge: runGit(repo.path, ['rev-parse', 'HEAD']).trim(), first, second };
  }

  it('points a file that arrived from the second parent at that parent, under the path it holds', async () => {
    const { merge, first, second } = mergeRepo();

    // Premise of the whole fix: against the first parent this file has no
    // content change at all, so the old first-parent-only resolution opened a
    // diff with nothing in it.
    expect(hasContentChange(repo.path, first, merge, 'renamed.txt', 'a.txt')).toBe(false);
    expect(hasContentChange(repo.path, second, merge, 'renamed.txt')).toBe(true);

    const { perFile } = await git.resolveCommitFileBases(merge);
    const base = perFile.get('renamed.txt');
    expect(base).toEqual({ ref: second, path: 'renamed.txt' });
    // Not `a.txt`: the winning parent already calls it renamed.txt, so pairing
    // that parent with the union list's oldPath would read a missing blob.
    expect(base!.path).not.toBe('a.txt');
  });

  it('agrees with the diff commitFileDiff produces for the same file', async () => {
    const { merge, second } = mergeRepo();

    // showCommitDiff → commitFileDiff walks parents on "parsed hunks > 0";
    // resolveCommitFileBases walks them on srcSha !== dstSha. Same parent, or
    // the editor and the in-webview diff show different things.
    const shown = await git.showCommitDiff(merge, 'renamed.txt', 'a.txt');
    expect(shown[0]?.hunks.length ?? 0).toBeGreaterThan(0);
    expect((await git.resolveCommitFileBases(merge)).perFile.get('renamed.txt')?.ref).toBe(second);
  });

  it('leaves a first-parent-only file on the first parent', async () => {
    const { merge, first } = mergeRepo();
    const { fallbackRef, perFile } = await git.resolveCommitFileBases(merge);

    expect(fallbackRef).toBe(first);
    expect(perFile.get('b.txt')).toEqual({ ref: first, path: 'b.txt' });
  });

  it('resolves an ordinary commit to its single parent with no per-file work', async () => {
    const parent = commit(repo.path, 'first', { 'a.txt': BASE });
    const child = commit(repo.path, 'second', { 'a.txt': `${BASE}more\n` });

    const { fallbackRef, perFile } = await git.resolveCommitFileBases(child);
    expect(fallbackRef).toBe(parent);
    expect(perFile.size).toBe(0);
  });

  it('resolves a root commit to the empty tree', async () => {
    const root = commit(repo.path, 'root', { 'a.txt': BASE });
    const { fallbackRef, perFile } = await git.resolveCommitFileBases(root);

    // Pin the actual object, not just "something else": the left side of a root
    // commit's diff IS this tree, and a wrong value here reads as a git error
    // rather than an empty file.
    expect(fallbackRef).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(fallbackRef).not.toBe(root);
    expect(perFile.size).toBe(0);
  });
});
/* SNIPCODE-HOOK end */
