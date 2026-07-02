import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGraphCopyPayload } from '../src/prCopyService.js';

const diff = [
  { path: 'a.ts', status: 'M' },
  { path: 'b.ts', status: 'A' },
  { path: 'new.ts', status: 'R', oldPath: 'old.ts' },
];
test('keeps only selected, hash=HEAD', () => {
  const p = toGraphCopyPayload('/repo', diff, new Set(['a.ts', 'new.ts']));
  assert.equal(p.hash, 'HEAD');
  assert.deepEqual(p.files.map(f => f.relativePath), ['a.ts', 'new.ts']);
  assert.equal(p.files[1].oldRelativePath, 'old.ts');
  assert.equal(p.files[0].repoRootFsPath, '/repo');
});
test('empty selection → no files', () =>
  assert.equal(toGraphCopyPayload('/repo', diff, new Set()).files.length, 0));
