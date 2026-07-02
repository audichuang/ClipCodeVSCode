import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameStatus, parseAheadBehind } from '../src/branchDiff.js';

test('parseNameStatus: M/A/D + rename', () => {
  const out = 'M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR100\tsrc/old.ts\tsrc/new.ts\n';
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
