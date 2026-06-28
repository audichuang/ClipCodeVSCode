import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

describe('GitService integration — search & stats', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('searchCommits', () => {
    it('filters by message substring (case-insensitive)', async () => {
      commit(repo.path, 'fix: handle null user');
      commit(repo.path, 'feat: add login flow');
      commit(repo.path, 'refactor: rename helper');

      const results = await svc.searchCommits('feat');
      const subjects = results.map(c => c.subject);
      expect(subjects).toContain('feat: add login flow');
      expect(subjects).not.toContain('fix: handle null user');
    });

    it('filters by author', async () => {
      commit(repo.path, 'one');
      runGit(repo.path, ['commit', '--allow-empty', '-m', 'two', '--author=Alice <alice@example.com>']);
      runGit(repo.path, ['commit', '--allow-empty', '-m', 'three', '--author=Bob <bob@example.com>']);

      const results = await svc.searchCommits('', { author: 'Alice' });
      expect(results.length).toBe(1);
      expect(results[0].author.name).toBe('Alice');
    });

    it('respects the limit option', async () => {
      for (let i = 0; i < 5; i++) commit(repo.path, `match ${i}`);
      const results = await svc.searchCommits('match', { limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe('searchByFile', () => {
    it('returns commits that touched the given path', async () => {
      commit(repo.path, 'unrelated', { 'a.txt': 'a\n' });
      const c2 = commit(repo.path, 'create target', { 'target.txt': '1\n' });
      const c3 = commit(repo.path, 'modify target', { 'target.txt': '2\n' });

      const results = await svc.searchByFile('target.txt');
      const hashes = results.map(c => c.hash);
      expect(hashes).toContain(c2);
      expect(hashes).toContain(c3);
      expect(results.find(c => c.subject === 'unrelated')).toBeUndefined();
    });

    it('returns empty for an unknown path', async () => {
      commit(repo.path, 'init');
      const results = await svc.searchByFile('does-not-exist.txt');
      expect(results).toEqual([]);
    });
  });

  describe('searchByHash', () => {
    it('returns the matching commit', async () => {
      commit(repo.path, 'first');
      const target = commit(repo.path, 'find me');

      const found = await svc.searchByHash(target);
      expect(found).not.toBeNull();
      expect(found?.hash).toBe(target);
      expect(found?.subject).toBe('find me');
    });

    it('returns null for an unknown hash', async () => {
      commit(repo.path, 'init');
      const found = await svc.searchByHash('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(found).toBeNull();
    });
  });

  describe('statsCommitsByAuthor', () => {
    it('aggregates commit counts by author', async () => {
      runGit(repo.path, ['commit', '--allow-empty', '-m', '1', '--author=Alice <a@x.com>']);
      runGit(repo.path, ['commit', '--allow-empty', '-m', '2', '--author=Alice <a@x.com>']);
      runGit(repo.path, ['commit', '--allow-empty', '-m', '3', '--author=Bob <b@x.com>']);

      const stats = await svc.statsCommitsByAuthor();
      const alice = stats.find(s => s.author === 'Alice');
      const bob = stats.find(s => s.author === 'Bob');
      expect(alice?.count).toBe(2);
      expect(bob?.count).toBe(1);
      expect(alice?.email).toBe('a@x.com');
    });

    it('counts authors deterministically across multiple commits', async () => {
      runGit(repo.path, ['commit', '--allow-empty', '-m', 'solo', '--author=Charlie <c@x.com>']);
      const stats = await svc.statsCommitsByAuthor();
      expect(stats.length).toBe(1);
      expect(stats[0].author).toBe('Charlie');
      expect(stats[0].count).toBe(1);
    });
  });

  describe('statsCommitsByWeekdayHour', () => {
    it('returns weekday/hour buckets with counts', async () => {
      commit(repo.path, 'one');
      commit(repo.path, 'two');
      commit(repo.path, 'three');

      const buckets = await svc.statsCommitsByWeekdayHour();
      // Three commits, all at the same fixed time from NOISY_ENV_OVERRIDES,
      // should land in a single bucket with count 3.
      expect(buckets.length).toBe(1);
      expect(buckets[0].count).toBe(3);
      expect(buckets[0].weekday).toBeGreaterThanOrEqual(0);
      expect(buckets[0].weekday).toBeLessThanOrEqual(6);
      expect(buckets[0].hour).toBeGreaterThanOrEqual(0);
      expect(buckets[0].hour).toBeLessThanOrEqual(23);
    });
  });
});
