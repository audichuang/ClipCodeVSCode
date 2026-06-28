import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommitFileTree, collectFileNodes, dedupeFilesKeepNewest, resolveSourceNodes } from '../src/historyTree.js';

const commit = (over: any = {}) => ({ hash: 'H', message: 'm', parents: ['P'], ...over });
const change = (p: string, status = 5) => ({ uri: { fsPath: `/repo/${p}` }, status });

test('buildCommitFileTree compresses single-child folder chains', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/auth/login.ts'), change('src/auth/session.ts')]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'folder');
  assert.equal((nodes[0] as any).name, 'src/auth'); // src→auth chain merged
  assert.equal((nodes[0] as any).children.length, 2);
});

test('buildCommitFileTree keeps branching folders separate', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/a.ts'), change('test/b.ts')]);
  const names = nodes.map((n: any) => n.name).sort();
  assert.deepEqual(names, ['src', 'test']);
});

test('collectFileNodes flattens a folder subtree', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/auth/login.ts'), change('src/auth/session.ts')]);
  assert.equal(collectFileNodes(nodes[0]).length, 2);
});

test('dedupeFilesKeepNewest keeps the newer commitDate per path', () => {
  const older = buildCommitFileTree('/repo', commit({ hash: 'OLD', commitDate: new Date(1000) }), [change('a.ts')]);
  const newer = buildCommitFileTree('/repo', commit({ hash: 'NEW', commitDate: new Date(2000) }), [change('a.ts')]);
  const deduped = dedupeFilesKeepNewest([...collectFileNodes(older[0]), ...collectFileNodes(newer[0])]);
  assert.equal(deduped.length, 1);
  assert.equal((deduped[0] as any).commit.hash, 'NEW');
});

test('resolveSourceNodes precedence: selected-with-clicked, then clicked, then treeSelection', () => {
  assert.deepEqual(resolveSourceNodes('c', ['a', 'c'], ['z']), ['a', 'c']);
  assert.deepEqual(resolveSourceNodes('c', ['a', 'b'], ['z']), ['c']); // selected lacks clicked → clicked
  assert.deepEqual(resolveSourceNodes(undefined, undefined, ['z']), ['z']);
});
