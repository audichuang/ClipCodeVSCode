import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBanner, toGraphCopyPayload } from '../src/prCopyService.js';

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

test('formatBanner: behind>0 warns to pull', () => {
  const msg = formatBanner({ ahead: 0, behind: 3, upstream: 'origin/main', fetched: true, fetchAttempted: true });
  assert.equal(msg, '⚠ origin/main 有 3 個新 commit,建議 pull');
});
test('formatBanner: behind===0 && upstream shows synced', () => {
  const msg = formatBanner({ ahead: 2, behind: 0, upstream: 'origin/main', fetched: true, fetchAttempted: true });
  assert.equal(msg, '✓ 與 origin/main 同步(ahead 2)');
});
test('formatBanner: !upstream shows no-upstream note', () => {
  const msg = formatBanner({ ahead: 0, behind: 0, upstream: undefined, fetched: false, fetchAttempted: false });
  assert.equal(msg, '本分支無對應 origin 分支');
});
test('formatBanner: fetchAttempted && !fetched appends offline note', () => {
  const msg = formatBanner({ ahead: 2, behind: 0, upstream: 'origin/main', fetched: false, fetchAttempted: true });
  assert.equal(msg, '✓ 與 origin/main 同步(ahead 2)（未能連線 remote，以下為本地快取狀態）');
});
test('formatBanner: fetched → no offline note even if fetchAttempted', () => {
  const msg = formatBanner({ ahead: 0, behind: 0, upstream: undefined, fetched: true, fetchAttempted: true });
  assert.equal(msg, '本分支無對應 origin 分支');
});
