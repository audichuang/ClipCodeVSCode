import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlamePorcelain } from '../src/blame/blameParser.js';

const ZERO = '0000000000000000000000000000000000000000';

// Two committed lines from one commit, then one uncommitted line.
const sample = [
  'a3f19c0000000000000000000000000000000000 12 12 2',
  'author Wang',
  'author-mail <wang@example.com>',
  'author-time 1700000000',
  'author-tz +0800',
  'committer Wang',
  'committer-time 1700000000',
  'committer-tz +0800',
  'summary fix fee',
  'filename src/payment.ts',
  '\tconst fee = amount * 0.03;',
  'a3f19c0000000000000000000000000000000000 13 13',
  '\tconst total = amount + fee;',
  ZERO + ' 14 14 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1700009999',
  'author-tz +0800',
  'summary Version of ... not committed',
  'filename src/payment.ts',
  '\tif (total > 100000) throw new Error();',
  ''
].join('\n');

test('parses committed lines and reuses commit metadata by sha', () => {
  const lines = parseBlamePorcelain(sample);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].finalLine, 12);
  assert.equal(lines[0].commit.author, 'Wang');
  assert.equal(lines[0].commit.summary, 'fix fee');
  assert.equal(lines[0].commit.authorTime, 1700000000);
  assert.equal(lines[0].commit.isUncommitted, false);
  // Line 13 repeats only the sha header — metadata must come from the cache.
  assert.equal(lines[1].finalLine, 13);
  assert.equal(lines[1].commit.author, 'Wang');
});

test('flags all-zero sha as uncommitted', () => {
  const lines = parseBlamePorcelain(sample);
  assert.equal(lines[2].finalLine, 14);
  assert.equal(lines[2].commit.isUncommitted, true);
});
