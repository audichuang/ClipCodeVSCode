import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

/**
 * Regression coverage for `getOperationState`. The function is the single
 * source of truth that the rest of the codebase uses to ask "is git busy?",
 * and recent fixes (a79f444) tightened the rebase-detection path because
 * `REBASE_HEAD` can linger after a successful `rebase --continue`. These
 * tests pin each detected operation type individually.
 */
describe('GitService.getOperationState — operation detection', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('returns null when no operation is in progress', async () => {
    commit(repo.path, 'init');
    expect((await svc.getOperationState()).type).toBeNull();
  });

  describe('rebase detection (a79f444 regression)', () => {
    it('detects rebase via rebase-merge state directory', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();

      // git's rebase machinery uses rebase-merge for interactive-style rebase
      expect(existsSync(join(repo.path, '.git', 'rebase-merge'))).toBe(true);
      expect((await svc.getOperationState()).type).toBe('rebase');

      await svc.abortRebase();
      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('does NOT report rebase when only stale REBASE_HEAD remains', async () => {
      // Reproduces the original bug: git keeps REBASE_HEAD pointing at the
      // last applied commit after a successful `rebase --continue`. Before
      // the fix this surfaced as a phantom "rebase in progress" state.
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      // Write REBASE_HEAD manually so we can simulate the leftover without
      // running a real rebase (the state dir cleanup is what matters).
      writeFileSync(
        join(repo.path, '.git', 'REBASE_HEAD'),
        runGit(repo.path, ['rev-parse', 'HEAD']).trim() + '\n',
      );

      // No rebase-merge / rebase-apply directory → not actually in progress.
      expect(existsSync(join(repo.path, '.git', 'rebase-merge'))).toBe(false);
      expect(existsSync(join(repo.path, '.git', 'rebase-apply'))).toBe(false);

      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('merge / cherry-pick / revert / squash detection', () => {
    it('detects merge via MERGE_HEAD', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('merge');
    });

    it('detects cherry-pick via CHERRY_PICK_HEAD', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const target = commit(repo.path, 'feature edit', { 'a.txt': 'feature\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      // Conflicting cherry-pick leaves CHERRY_PICK_HEAD until resolved/aborted.
      await expect(svc.cherryPick(target)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('cherry-pick');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('detects revert via REVERT_HEAD', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'change', { 'a.txt': 'two\n' });
      // Move HEAD forward with conflicting content so reverting `target`
      // hits a conflict and parks REVERT_HEAD.
      commit(repo.path, 'further change', { 'a.txt': 'three\n' });

      await expect(svc.revert(target)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('revert');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('detects squash via SQUASH_MSG (when no other op markers present)', async () => {
      commit(repo.path, 'init');
      // Synthesize a leftover SQUASH_MSG; git writes this during
      // `merge --squash` and after a squash-merge it remains until the
      // squash commit is finalised.
      writeFileSync(join(repo.path, '.git', 'SQUASH_MSG'), 'Squashed commit\n');
      expect((await svc.getOperationState()).type).toBe('squash');
    });

    it('merge takes precedence over SQUASH_MSG when both present', async () => {
      // Real `merge --squash` followed by a conflicting merge would technically
      // be illegal, but we still want a defined precedence so the UI never
      // shows two banners. MERGE_HEAD is checked first.
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      writeFileSync(join(repo.path, '.git', 'SQUASH_MSG'), 'leftover\n');

      expect((await svc.getOperationState()).type).toBe('merge');
    });
  });
});
