import assert from 'node:assert/strict';
import test from 'node:test';
import { blameCacheKey, BlameCache } from '../src/blame/blameCache.js';

test('cache key changes with head or document version', () => {
  const a = blameCacheKey('/repo', 'HEAD1', 3);
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD2', 3));
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD1', 4));
  assert.equal(a, blameCacheKey('/repo', 'HEAD1', 3));
});

test('cache stores and invalidates', () => {
  const cache = new BlameCache();
  const key = blameCacheKey('/repo', 'HEAD1', 1);
  assert.equal(cache.get(key), undefined);
  cache.set(key, [{ finalLine: 1, commit: { sha: 'x', author: 'A', authorTime: 1, summary: 's', isUncommitted: false } }]);
  assert.equal(cache.get(key)?.length, 1);
  cache.delete(key);
  assert.equal(cache.get(key), undefined);
});
