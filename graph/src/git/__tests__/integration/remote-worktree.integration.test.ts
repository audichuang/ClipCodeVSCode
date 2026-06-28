import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit } from './helpers';

describe('GitService integration — remote operations (local bare)', () => {
  let workRepo: TempRepo;
  let bareRepo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    workRepo = createTempRepo();
    bareRepo = createTempRepo({ bare: true });
    svc = new GitService(workRepo.path);
    // Seed local with a commit and point its origin at the bare repo.
    commit(workRepo.path, 'init', { 'a.txt': 'a\n' });
    runGit(workRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
  });
  afterEach(() => {
    workRepo.cleanup();
    bareRepo.cleanup();
  });

  describe('push / fetch / pull round-trip', () => {
    it('push uploads commits to bare and sets upstream', async () => {
      await svc.push('origin', 'main', { setUpstream: true });

      // The bare repo's main ref now points at our HEAD.
      const bareHead = runGit(bareRepo.path, ['rev-parse', 'refs/heads/main']).trim();
      expect(bareHead).toBe(head(workRepo.path));
    });

    it('fetch downloads new commits from another clone', async () => {
      // First push from work → bare
      await svc.push('origin', 'main', { setUpstream: true });

      // Set up a second clone, commit there, push back to bare
      const otherRepo = createTempRepo();
      try {
        runGit(otherRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
        runGit(otherRepo.path, ['fetch', 'origin']);
        runGit(otherRepo.path, ['checkout', '-b', 'main', 'origin/main']);
        commit(otherRepo.path, 'from other', { 'b.txt': 'b\n' });
        const otherHead = head(otherRepo.path);
        runGit(otherRepo.path, ['push', 'origin', 'main']);

        // Now fetch from our service
        await svc.fetch('origin');

        // origin/main should now reference the new commit
        const refSha = runGit(workRepo.path, ['rev-parse', 'refs/remotes/origin/main']).trim();
        expect(refSha).toBe(otherHead);
      } finally {
        otherRepo.cleanup();
      }
    });

    it('fetch with prune removes remote-tracking refs deleted on the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      // Publish a throwaway branch, fetch it, then delete it on the remote.
      runGit(workRepo.path, ['branch', 'temp']);
      runGit(workRepo.path, ['push', 'origin', 'temp']);
      await svc.fetch('origin');
      expect(() => runGit(workRepo.path, ['rev-parse', 'refs/remotes/origin/temp'])).not.toThrow();

      runGit(bareRepo.path, ['update-ref', '-d', 'refs/heads/temp']); // delete on remote
      await svc.fetch('origin', { prune: true });

      const remoteRefs = runGit(workRepo.path, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
      expect(remoteRefs).not.toContain('origin/temp');
    });

    it('pull --rebase replays local commits on top of fetched remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });

      // Make a divergent commit elsewhere and push it to bare
      const otherRepo = createTempRepo();
      try {
        runGit(otherRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
        runGit(otherRepo.path, ['fetch', 'origin']);
        runGit(otherRepo.path, ['checkout', '-b', 'main', 'origin/main']);
        commit(otherRepo.path, 'upstream change', { 'upstream.txt': 'u\n' });
        runGit(otherRepo.path, ['push', 'origin', 'main']);

        // Local-only commit
        commit(workRepo.path, 'local change', { 'local.txt': 'l\n' });

        await svc.pull('origin', 'main', { rebase: true });

        // Both files should now be present on local, in a linear history
        expect(existsSync(join(workRepo.path, 'upstream.txt'))).toBe(true);
        expect(existsSync(join(workRepo.path, 'local.txt'))).toBe(true);
        const parents = runGit(workRepo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
        expect(parents.length).toBe(1); // linear, no merge commit
      } finally {
        otherRepo.cleanup();
      }
    });
  });

  describe('tag push / delete', () => {
    it('pushTag uploads a tag to the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v1.0']);
      await svc.pushTag('v1.0', 'origin');

      const remoteTag = runGit(bareRepo.path, ['rev-parse', 'refs/tags/v1.0']).trim();
      expect(remoteTag).toBe(head(workRepo.path));
    });

    it('deleteRemoteTag removes the remote tag', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v0.1']);
      await svc.pushTag('v0.1', 'origin');

      await svc.deleteRemoteTag('v0.1', 'origin');
      const refs = runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim();
      expect(refs).not.toContain('v0.1');
    });

    it('pushAllTags uploads every local tag', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v0.1']);
      runGit(workRepo.path, ['tag', 'v0.2']);

      await svc.pushAllTags('origin');
      const remoteTags = runGit(bareRepo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).trim();
      expect(remoteTags).toContain('v0.1');
      expect(remoteTags).toContain('v0.2');
    });

    it('pushTag / deleteRemoteTag default to origin when no remote is given', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v9.0']);

      // Omitting the remote argument exercises the `remote || 'origin'` fallback.
      await svc.pushTag('v9.0');
      expect(runGit(bareRepo.path, ['rev-parse', 'refs/tags/v9.0']).trim()).toBe(head(workRepo.path));

      await svc.deleteRemoteTag('v9.0');
      expect(runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim()).not.toContain('v9.0');
    });

    it('pushTagToAllRemotes pushes the tag to every configured remote', async () => {
      const mirror = createTempRepo({ bare: true });
      try {
        runGit(workRepo.path, ['remote', 'add', 'mirror', mirror.path]);
        runGit(workRepo.path, ['tag', 'v3.0']);

        await svc.pushTagToAllRemotes('v3.0');

        const tip = head(workRepo.path);
        expect(runGit(bareRepo.path, ['rev-parse', 'refs/tags/v3.0']).trim()).toBe(tip);
        expect(runGit(mirror.path, ['rev-parse', 'refs/tags/v3.0']).trim()).toBe(tip);
      } finally {
        mirror.cleanup();
      }
    });

    it('deleteTagFromAllRemotes removes the tag from every configured remote', async () => {
      const mirror = createTempRepo({ bare: true });
      try {
        runGit(workRepo.path, ['remote', 'add', 'mirror', mirror.path]);
        runGit(workRepo.path, ['tag', 'v4.0']);
        await svc.pushTagToAllRemotes('v4.0');
        // Sanity: the tag is present on both remotes before deletion.
        expect(runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim()).toContain('v4.0');
        expect(runGit(mirror.path, ['for-each-ref', 'refs/tags']).trim()).toContain('v4.0');

        await svc.deleteTagFromAllRemotes('v4.0');

        expect(runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim()).not.toContain('v4.0');
        expect(runGit(mirror.path, ['for-each-ref', 'refs/tags']).trim()).not.toContain('v4.0');
      } finally {
        mirror.cleanup();
      }
    });

    it('deleteTagFromAllRemotes skips remotes that do not have the tag', async () => {
      const mirror = createTempRepo({ bare: true });
      try {
        runGit(workRepo.path, ['remote', 'add', 'mirror', mirror.path]);
        runGit(workRepo.path, ['tag', 'v5.0']);
        // Push the tag to origin only; mirror never receives it.
        await svc.pushTag('v5.0', 'origin');

        // Must not throw even though mirror has no such tag.
        await expect(svc.deleteTagFromAllRemotes('v5.0')).resolves.toBeUndefined();

        expect(runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim()).not.toContain('v5.0');
      } finally {
        mirror.cleanup();
      }
    });
  });

  describe('deleteRemoteBranch', () => {
    it('removes a branch from the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'feature']);
      commit(workRepo.path, 'feature commit', { 'f.txt': 'f\n' });
      await svc.push('origin', 'feature', { setUpstream: true });

      await svc.deleteRemoteBranch('feature', 'origin');
      const refs = runGit(bareRepo.path, ['for-each-ref', 'refs/heads']).trim();
      expect(refs).not.toContain('feature');
    });

    it('defaults to origin when no remote is given', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'throwaway']);
      commit(workRepo.path, 'throwaway commit', { 't.txt': 't\n' });
      await svc.push('origin', 'throwaway', { setUpstream: true });

      // No remote argument → falls back to origin.
      await svc.deleteRemoteBranch('throwaway');
      const refs = runGit(bareRepo.path, ['for-each-ref', 'refs/heads']).trim();
      expect(refs).not.toContain('throwaway');
    });
  });

  describe('setUpstream', () => {
    it('configures upstream tracking', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'topic']);
      // push topic without -u first so we can test setUpstream() afterwards
      runGit(workRepo.path, ['push', 'origin', 'topic']);

      await svc.setUpstream('topic', 'origin', 'topic');

      const upstream = runGit(workRepo.path, ['rev-parse', '--abbrev-ref', 'topic@{upstream}']).trim();
      expect(upstream).toBe('origin/topic');
    });

    it('with createRemote: pushes a branch that does not yet exist on the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'fresh-topic']);
      commit(workRepo.path, 'fresh', { 'fresh.txt': 'f\n' });

      // fresh-topic does NOT yet exist on origin. createRemote should push it.
      await svc.setUpstream('fresh-topic', 'origin', 'fresh-topic', { createRemote: true });

      // The bare repo should now have refs/heads/fresh-topic at our local tip.
      const remoteSha = runGit(bareRepo.path, ['rev-parse', 'refs/heads/fresh-topic']).trim();
      expect(remoteSha).toBe(head(workRepo.path));
      // And upstream tracking should be set.
      const upstream = runGit(workRepo.path, ['rev-parse', '--abbrev-ref', 'fresh-topic@{upstream}']).trim();
      expect(upstream).toBe('origin/fresh-topic');
    });
  });

  describe('log remoteFilter', () => {
    it('excludes remote-only commits with the "local" filter but includes them for the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      // A second clone advances origin/main with a commit that is NOT local.
      const otherRepo = createTempRepo();
      try {
        runGit(otherRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
        runGit(otherRepo.path, ['fetch', 'origin']);
        runGit(otherRepo.path, ['checkout', '-b', 'main', 'origin/main']);
        commit(otherRepo.path, 'remote-only', { 'r.txt': 'r\n' });
        runGit(otherRepo.path, ['push', 'origin', 'main']);
        await svc.fetch('origin'); // origin/main now ahead of local main

        const localOnly = (await svc.log({ remoteFilter: ['local'] })).map(c => c.subject);
        expect(localOnly).not.toContain('remote-only');

        const withRemote = (await svc.log({ remoteFilter: ['origin'] })).map(c => c.subject);
        expect(withRemote).toContain('remote-only');
      } finally {
        otherRepo.cleanup();
      }
    });
  });
});

describe('GitService integration — worktrees', () => {
  let mainRepo: TempRepo;
  let svc: GitService;
  let extraPaths: string[] = [];

  beforeEach(() => {
    mainRepo = createTempRepo();
    svc = new GitService(mainRepo.path);
    commit(mainRepo.path, 'init', { 'a.txt': 'a\n' });
    extraPaths = [];
  });
  afterEach(() => {
    // Worktrees living outside mainRepo.path need explicit cleanup.
    for (const p of extraPaths) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    mainRepo.cleanup();
  });

  function siblingPath(name: string): string {
    // place the worktree as a sibling of the main repo so it's still cleaned up
    // by the harness's tmpdir teardown but doesn't sit inside the repo itself.
    const p = `${mainRepo.path}-${name}`;
    extraPaths.push(p);
    return p;
  }

  describe('worktreeList', () => {
    it('returns the main worktree initially', async () => {
      const list = await svc.worktreeList();
      expect(list.length).toBe(1);
      expect(list[0].isMain).toBe(true);
    });
  });

  describe('worktreeAdd / worktreeRemove', () => {
    it('adds a new worktree on a new branch', async () => {
      const wtPath = siblingPath('wt1');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');

      const list = await svc.worktreeList();
      expect(list.length).toBe(2);
      const newWt = list.find(w => !w.isMain);
      expect(newWt).toBeDefined();
      expect(newWt?.branch).toContain('feature-wt');
      expect(existsSync(wtPath)).toBe(true);

      // Branch is now reported by branches()
      const branchNames = (await svc.branches()).map(b => b.name);
      expect(branchNames).toContain('feature-wt');
    });

    it('adds a detached worktree at a commit and reports detached:true', async () => {
      const wtPath = siblingPath('wt-detached');
      // Passing a commit (not a new branch) checks it out detached.
      await svc.worktreeAdd(wtPath, head(mainRepo.path));

      const detached = (await svc.worktreeList()).find(w => !w.isMain);
      expect(detached).toBeDefined();
      expect(detached!.detached).toBe(true);
      expect(detached!.branch).toBe('');
    });

    it('worktreeRemove drops it', async () => {
      const wtPath = siblingPath('wt2');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');
      await svc.worktreeRemove(wtPath);

      const list = await svc.worktreeList();
      expect(list.length).toBe(1);
      expect(existsSync(wtPath)).toBe(false);
    });

    it('worktreeRemove with force succeeds even when the worktree is dirty', async () => {
      const wtPath = siblingPath('wt-dirty');
      await svc.worktreeAdd(wtPath, undefined, 'dirty-branch');

      // Dirty the worktree so non-force remove would be rejected by git.
      const { writeFileSync } = await import('fs');
      writeFileSync(`${wtPath}/junk.txt`, 'uncommitted\n');

      await svc.worktreeRemove(wtPath, true);

      expect(existsSync(wtPath)).toBe(false);
      const list = await svc.worktreeList();
      expect(list.length).toBe(1);
    });

    it('worktreePrune cleans up missing worktree metadata', async () => {
      const wtPath = siblingPath('wt3');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');

      // Delete the worktree directory out from under git, then prune.
      rmSync(wtPath, { recursive: true, force: true });
      await svc.worktreePrune();

      const list = await svc.worktreeList();
      expect(list.length).toBe(1); // only main remains
    });
  });
});
