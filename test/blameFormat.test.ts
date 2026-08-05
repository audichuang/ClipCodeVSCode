import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime, ageBucket, AGE_BUCKETS } from '../src/blame/blameFormat.js';

const NOW = 1_700_000_000;

test('formats relative time in coarse buckets', () => {
  assert.equal(formatRelativeTime(NOW - 30, NOW), '剛剛');
  assert.equal(formatRelativeTime(NOW - 120, NOW), '2 分鐘前');
  assert.equal(formatRelativeTime(NOW - 2 * 3600, NOW), '2 小時前');
  assert.equal(formatRelativeTime(NOW - 3 * 86400, NOW), '3 天前');
  assert.equal(formatRelativeTime(NOW - 60 * 86400, NOW), '2 個月前');
  assert.equal(formatRelativeTime(NOW - 400 * 86400, NOW), '1 年前');
});

test('ageBucket returns 0 for newest and grows with age, clamped', () => {
  assert.equal(ageBucket(NOW, NOW), 0);
  const old = ageBucket(NOW - 5000 * 86400, NOW);
  assert.equal(old, AGE_BUCKETS - 1);
  assert.ok(ageBucket(NOW - 30 * 86400, NOW) > 0);
});
