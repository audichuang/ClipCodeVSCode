// ui/diff X3/D3/R5 — rename-aware diff pathspec.
//
// A single-pathspec `git diff -- <newPath>` cannot pair a rename: git only
// detects one when BOTH the old and new path are visible to it (`-M` plus
// both pathspecs). Without that, a renamed+modified file renders as an
// unrelated whole-file "new file" add (X3), and a renamed-only file with
// content unchanged renders as nothing at all (empty hunks). These tests
// prove GitService's oldPath-aware pathspec (getUncommittedFileDiff /
// commitFileDiff via showCommitDiff) fixes both, using real git — no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService, StaleDiffError } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

// A file big enough that renaming it with a couple of edited lines still
// scores well above git's default 50% rename-similarity threshold — a tiny
// 1-2 line file that changes entirely scores 0% and git will NOT pair it
// even with a low -M threshold (verified against real git 2.43).
const BASE = [
  'export interface User {',
  '  id: string;',
  '  name: string;',
  '}',
  '',
  'export function formatUser(user: User): string {',
  '  return `${user.name} (${user.id})`;',
  '}',
  '',
  'export function validateId(id: string): boolean {',
  '  return id.length > 0;',
  '}',
  '',
  'export class UserRepository {',
  '  private users: Map<string, User> = new Map();',
  '',
  '  add(user: User): void {',
  '    this.users.set(user.id, user);',
  '  }',
  '',
  '  remove(id: string): boolean {',
  '    return this.users.delete(id);',
  '  }',
  '}',
  '',
].join('\n');

function renamedAndModified(): string {
  return BASE
    .replace('  return id.length > 0;', '  return id.trim().length > 0;')
    .replace(
      '  remove(id: string): boolean {\n    return this.users.delete(id);\n  }',
      '  remove(id: string): boolean {\n    const existed = this.users.has(id);\n    this.users.delete(id);\n    return existed;\n  }',
    );
}

describe('GitService integration — rename-aware diff pathspec', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('uncommitted (getUncommittedFileDiff)', () => {
    beforeEach(() => {
      commit(repo.path, 'base', { 'old.ts': BASE });
    });

    /* SNIPCODE-HOOK start: live-QA-2 this test used to assert the OPPOSITE — that
       an un-told staged rename renders as a whole-file add. That was the status
       quo, not the intent: the caller cannot always know the rename (the Diff
       tab shows both sides of one file, and the unstaged node of a renamed+
       edited file carries no oldPath), so GitService now resolves the side's
       rename source from git status itself. Inverted with the fix. */
    it('with NO oldPath argument: a staged rename+modify still pairs — the service resolves it from git status', async () => {
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      const diff = await svc.getUncommittedFileDiff('new.ts', true);
      expect(diff).not.toBeNull();
      expect(diff!.oldPath).toBe('old.ts');
      expect(diff!.similarity).toBeGreaterThanOrEqual(50);
      // A small real change, NOT the whole file re-added.
      const addCount = diff!.hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length;
      expect(addCount).toBeLessThan(6);
    });
    /* SNIPCODE-HOOK end */

    it('WITH oldPath: a staged rename+modify pairs correctly — oldPath/similarity set, small real hunk', async () => {
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      const diff = await svc.getUncommittedFileDiff('new.ts', true, 'old.ts');
      expect(diff).not.toBeNull();
      expect(diff!.oldPath).toBe('old.ts');
      expect(diff!.similarity).toBeGreaterThanOrEqual(50);
      // Two small hunks (one per edited line), not a whole-file add.
      const addCount = diff!.hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length;
      const delCount = diff!.hunks.flatMap(h => h.lines).filter(l => l.type === 'delete').length;
      expect(addCount).toBeLessThan(6);
      expect(delCount).toBeLessThan(6);
    });

    it('WITH oldPath: a rename-only (unmodified) file gets 100% similarity + empty hunks, not silently dropped', async () => {
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      runGit(repo.path, ['add', '-A']);

      const diff = await svc.getUncommittedFileDiff('new.ts', true, 'old.ts');
      expect(diff).not.toBeNull();
      expect(diff!.oldPath).toBe('old.ts');
      expect(diff!.similarity).toBe(100);
      expect(diff!.hunks).toHaveLength(0);
    });

    it('a STAGED rename with further unstaged edits on top still pairs the staged side with oldPath', async () => {
      // git mv stages the rename; further edits after that land unstaged. The
      // oldPath fix must keep working for the staged side even though the
      // unstaged side (index -> working tree, both under the new name) has no
      // rename of its own to pair — that side never needed oldPath.
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', 'new.ts']);
      // One more unstaged edit on top, purely under the new name.
      writeFile(repo.path, 'new.ts', renamedAndModified().replace('validateId', 'validateUserId'));

      const staged = await svc.getUncommittedFileDiff('new.ts', true, 'old.ts');
      expect(staged!.oldPath).toBe('old.ts');

      const unstaged = await svc.getUncommittedFileDiff('new.ts', false);
      expect(unstaged).not.toBeNull();
      expect(unstaged!.oldPath).toBeUndefined(); // no rename on this side — correct
    });

    /* SNIPCODE-HOOK start: live-QA-2 the reported failure, end to end. Opening
       this file from the UNSTAGED node gave the panel no oldPath (that node is
       plain `M`), and both sides were fetched with it — so the staged side lost
       its `-M` and rendered the rename as a whole-file add. Per-side resolution
       is what makes the two entry points agree. */
    it('an RM file renders the SAME on both sides no matter which node opened it', async () => {
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified().replace('validateId', 'validateUserId'));

      // Porcelain really does label the two sides differently — the premise.
      const status = await svc.getUncommittedDiff();
      expect(status.staged.find(f => f.path === 'new.ts')).toMatchObject({ status: 'R', oldPath: 'old.ts' });
      expect(status.unstaged.find(f => f.path === 'new.ts')).toMatchObject({ status: 'M' });
      expect(status.unstaged.find(f => f.path === 'new.ts')!.oldPath).toBeUndefined();

      // Opened from the unstaged node: no oldPath is passed for either side.
      const fromUnstagedNode = {
        staged: await svc.getUncommittedFileDiff('new.ts', true),
        unstaged: await svc.getUncommittedFileDiff('new.ts', false),
      };
      // Opened from the staged node: the panel used to pass 'old.ts' to BOTH.
      const fromStagedNode = {
        staged: await svc.getUncommittedFileDiff('new.ts', true, 'old.ts'),
        unstaged: await svc.getUncommittedFileDiff('new.ts', false, 'old.ts'),
      };

      expect(fromUnstagedNode.staged!.oldPath).toBe('old.ts');
      expect(fromUnstagedNode.staged!.fingerprint).toBe(fromStagedNode.staged!.fingerprint);
      expect(fromUnstagedNode.unstaged!.fingerprint).toBe(fromStagedNode.unstaged!.fingerprint);
      // Not a whole-file add: the staged side is a handful of changed lines.
      const adds = fromUnstagedNode.staged!.hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length;
      expect(adds).toBeLessThan(6);
    });

    it('an un-told staged rename is refused by the rename guard, not mis-staged as a whole-file patch', async () => {
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      // Rendered without oldPath, exactly as the Diff tab now fetches it.
      const rendered = await svc.getUncommittedFileDiff('new.ts', true);
      let caught: unknown;
      try {
        await svc.unstageHunks('new.ts', [0], rendered!.fingerprint!);
      } catch (err) {
        caught = err;
      }
      // The fingerprint still matches (both routes resolve the same oldPath),
      // so this is the honest "can't per-hunk a rename" refusal, not a stale diff.
      expect(caught).not.toBeInstanceOf(StaleDiffError);
      expect((caught as Error).message).toMatch(/mode or rename/);
      expect(runGit(repo.path, ['diff', '--cached', '--name-status', '-M'])).toMatch(/^R\d+\s+old\.ts\s+new\.ts/m);
    });
    /* SNIPCODE-HOOK end */
  });

  describe('committed (showCommitDiff / commitFileDiff)', () => {
    it('WITHOUT oldPath: a commit that renamed+modified a file renders the file as a whole-file add', async () => {
      commit(repo.path, 'base', { 'old.ts': BASE });
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      const renameCommit = commit(repo.path, 'rename+modify old.ts -> new.ts');

      const result = await svc.showCommitDiff(renameCommit, 'new.ts');
      expect(result[0].oldPath).toBeUndefined();
      expect(result[0].hunks[0].lines.every(l => l.type === 'add')).toBe(true);
    });

    it('WITH oldPath: showCommitDiff pairs the rename — oldPath/similarity set, small real hunk', async () => {
      commit(repo.path, 'base', { 'old.ts': BASE });
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      const renameCommit = commit(repo.path, 'rename+modify old.ts -> new.ts');

      const result = await svc.showCommitDiff(renameCommit, 'new.ts', 'old.ts');
      expect(result).toHaveLength(1);
      expect(result[0].oldPath).toBe('old.ts');
      expect(result[0].similarity).toBeGreaterThanOrEqual(50);
      const addCount = result[0].hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length;
      expect(addCount).toBeLessThan(6);
    });
  });

  /* SNIPCODE-HOOK start: ui/diff R5 — rename detection unblocks the per-hunk guard */
  describe('R5: rename pairing lets assertHunkStageable actually see the rename header', () => {
    it('the WITHOUT-oldPath raw diff has no rename/mode header (assertHunkStageable would NOT catch it)', async () => {
      commit(repo.path, 'base', { 'old.ts': BASE });
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      const raw = runGit(repo.path, ['diff', '--no-color', '--cached', '--', 'new.ts']);
      expect(raw).not.toMatch(/rename from/);
      expect(raw).toMatch(/new file mode/); // masquerades as a brand-new file
    });

    it('the WITH-oldPath raw diff carries a rename header (assertHunkStageable now blocks hunk-level unstage)', async () => {
      commit(repo.path, 'base', { 'old.ts': BASE });
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      const raw = runGit(repo.path, ['diff', '--no-color', '--cached', '-M', '--', 'old.ts', 'new.ts']);
      expect(raw).toMatch(/rename from old\.ts/);
      // This is exactly the header assertHunkStageable's existing regex blocks
      // (see git-service.test.ts "assertHunkStageable (R5)"); the fix here is
      // making the rename VISIBLE to it via the -M two-pathspec diff, not the
      // regex itself.
    });
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: X3 Diff tab oldPath threading */
  describe('X3: unstageHunks/stageHunks with oldPath end-to-end (Diff tab tree-click path)', () => {
    it('unstageHunks on a staged rename+modify, given the SAME oldPath the diff was rendered with, throws the clear R5 error — not StaleDiffError', async () => {
      commit(repo.path, 'base', { 'old.ts': BASE });
      runGit(repo.path, ['mv', 'old.ts', 'new.ts']);
      writeFile(repo.path, 'new.ts', renamedAndModified());
      runGit(repo.path, ['add', '-A']);

      // Exactly what DiffPanel.push does: render with oldPath, get its fingerprint.
      const rendered = await svc.getUncommittedFileDiff('new.ts', true, 'old.ts');
      expect(rendered!.oldPath).toBe('old.ts');
      expect(rendered!.hunks.length).toBeGreaterThan(0);

      // Exactly what the diffStageHunk handler now does: same oldPath, so the
      // raw bytes assertHunkStageable inspects are the SAME rename-shaped diff
      // that was rendered (not the pathspec-bug "new file" shape) — fingerprint
      // matches, so the rejection is the R5 message, never StaleDiffError.
      let caught: unknown;
      try {
        await svc.unstageHunks('new.ts', [0], rendered!.fingerprint!, 'old.ts');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(StaleDiffError);
      expect((caught as Error).message).toMatch(/mode or rename/);
      // And the mutation must not have gone through — the rename is still staged.
      expect(runGit(repo.path, ['diff', '--cached', '--name-status', '-M'])).toMatch(/^R\d+\s+old\.ts\s+new\.ts/m);
    });

    it('does not change stage/unstage of an ordinary (non-renamed) file — oldPath omitted, same as before', async () => {
      const BASE_LINE = 'alpha\nbeta\ngamma\ndelta\n';
      const CHANGED = 'alpha\nBETA\ngamma\nDELTA\n';
      commit(repo.path, 'base', { 'f.txt': BASE_LINE });
      writeFile(repo.path, 'f.txt', CHANGED);

      const rendered = await svc.getUncommittedFileDiff('f.txt', false);
      expect(rendered!.oldPath).toBeUndefined();
      await svc.stageHunks('f.txt', [0], rendered!.fingerprint!);

      expect(runGit(repo.path, ['diff', '--cached', 'f.txt'])).toContain('+BETA');
    });
  });
  /* SNIPCODE-HOOK end */
});
