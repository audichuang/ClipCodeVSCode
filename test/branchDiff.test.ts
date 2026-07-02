import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameStatus, parseAheadBehind } from '../src/branchDiff.js';

test('parseNameStatus: M/A/D + rename', () => {
  const out = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0R100\0src/old.ts\0src/new.ts\0';
  const r = parseNameStatus(out);
  assert.deepEqual(r[0], { path: 'src/a.ts', status: 'M' });
  assert.deepEqual(r[1], { path: 'src/b.ts', status: 'A' });
  assert.deepEqual(r[2], { path: 'src/c.ts', status: 'D' });
  assert.deepEqual(r[3], { path: 'src/new.ts', status: 'R', oldPath: 'src/old.ts' });
});
test('parseNameStatus: empty', () => assert.deepEqual(parseNameStatus(''), []));
test('parseAheadBehind: left=behind right=ahead', () =>
  assert.deepEqual(parseAheadBehind('3\t5'), { ahead: 5, behind: 3 }));
test('parseAheadBehind: zero', () => assert.deepEqual(parseAheadBehind('0\t0'), { ahead: 0, behind: 0 }));
test('parseAheadBehind: malformed → null', () => assert.equal(parseAheadBehind('x'), null));
