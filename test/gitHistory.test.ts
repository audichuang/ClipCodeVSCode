import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_TREE, listCommitFiles, listCommits, readFileAtCommit } from '../src/gitHistory.js';

function fakeRepo(overrides: any = {}) {
  return {
    rootUri: { fsPath: '/repo' },
    calls: [] as any[],
    async log(options: any) { this.calls.push(['log', options]); return overrides.commits ?? []; },
    async diffBetweenWithStats(ref1: string, ref2: string) { this.calls.push(['diff', ref1, ref2]); return overrides.changes ?? []; },
    async show(_ref: string, _p: string) { return overrides.show ? overrides.show(_ref, _p) : undefined; },
    ...overrides.methods,
  };
}

test('listCommits forwards maxEntries and skip', async () => {
  const repo = fakeRepo();
  await listCommits(repo as any, { limit: 50, skip: 100 });
  assert.deepEqual(repo.calls[0], ['log', { maxEntries: 50, skip: 100 }]);
});

test('listCommitFiles uses parent[0] for normal commit', async () => {
  const repo = fakeRepo({ changes: [{ uri: { fsPath: '/repo/a.ts' }, status: 5 }] });
  await listCommitFiles(repo as any, { hash: 'H', message: 'm', parents: ['P'] });
  assert.deepEqual(repo.calls[0], ['diff', 'P', 'H']);
});

test('listCommitFiles uses EMPTY_TREE for root commit', async () => {
  const repo = fakeRepo();
  await listCommitFiles(repo as any, { hash: 'ROOT', message: 'init', parents: [] });
  assert.deepEqual(repo.calls[0], ['diff', EMPTY_TREE, 'ROOT']);
});

test('readFileAtCommit returns deleted marker for DELETED status', async () => {
  const repo = fakeRepo();
  const change = { uri: { fsPath: '/repo/gone.ts' }, status: 6 }; // 6 = DELETED
  const content = await readFileAtCommit(repo as any, 'H', change);
  assert.equal(content, '// This file has been deleted in this change');
});

test('readFileAtCommit reads content at the commit hash for non-deleted', async () => {
  const repo = fakeRepo({ show: (_ref: string, _p: string) => 'AT_COMMIT' });
  const change = { uri: { fsPath: '/repo/a.ts' }, status: 5 };
  assert.equal(await readFileAtCommit(repo as any, 'HASH', change), 'AT_COMMIT');
});
