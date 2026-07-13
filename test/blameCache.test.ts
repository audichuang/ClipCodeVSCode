import assert from 'node:assert/strict';
import test from 'node:test';
import { blameCacheKey, BlameCache } from '../src/blame/blameCache.js';

test('cache key changes with head or document version', () => {
  const a = blameCacheKey('/repo', 'HEAD1', 3, '/repo/a.ts');
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD2', 3, '/repo/a.ts'));
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD1', 4, '/repo/a.ts'));
  assert.equal(a, blameCacheKey('/repo', 'HEAD1', 3, '/repo/a.ts'));
});

test('cache key keeps different file paths distinct at the same repo, head, and version', () => {
  const a = blameCacheKey('/repo', 'HEAD1', 3, '/repo/a.ts');
  const b = blameCacheKey('/repo', 'HEAD1', 3, '/repo/b.ts');
  const cache = new BlameCache();
  cache.set(a, [{ finalLine: 1, commit: { sha: 'a', author: 'A', authorTime: 1, summary: 'a', isUncommitted: false } }]);
  cache.set(b, [{ finalLine: 1, commit: { sha: 'b', author: 'B', authorTime: 1, summary: 'b', isUncommitted: false } }]);

  assert.notEqual(a, b);
  assert.equal(cache.get(a)?.[0].commit.sha, 'a');
  assert.equal(cache.get(b)?.[0].commit.sha, 'b');
});

test('cache stores and invalidates', () => {
  const cache = new BlameCache();
  const key = blameCacheKey('/repo', 'HEAD1', 1, '/repo/a.ts');
  assert.equal(cache.get(key), undefined);
  cache.set(key, [{ finalLine: 1, commit: { sha: 'x', author: 'A', authorTime: 1, summary: 's', isUncommitted: false } }]);
  assert.equal(cache.get(key)?.length, 1);
  cache.delete(key);
  assert.equal(cache.get(key), undefined);
});

test('setForDoc evicts the previous version for the same document, keeping the cache bounded', () => {
  const cache = new BlameCache();
  const docKey = 'file:///a.ts';
  const line = (finalLine: number) => [{ finalLine, commit: { sha: 'x', author: 'A', authorTime: 1, summary: 's', isUncommitted: false } }];

  // Simulate 50 keystrokes, each bumping document.version by one — without
  // eviction this would grow the cache to 50 entries.
  for (let version = 1; version <= 50; version++) {
    cache.setForDoc(docKey, blameCacheKey('/repo', 'HEAD1', version, '/repo/a.ts'), line(version));
  }

  assert.equal(cache.size, 1);
  assert.equal(cache.get(blameCacheKey('/repo', 'HEAD1', 50, '/repo/a.ts'))?.[0].finalLine, 50);
  assert.equal(cache.get(blameCacheKey('/repo', 'HEAD1', 1, '/repo/a.ts')), undefined);
});
