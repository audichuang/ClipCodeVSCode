import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('a shallow boundary commit is refused, not copied as the whole tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipcode-shallow-'));
  try {
    await mkdir(path.join(root, '.git'), { recursive: true });
    const repo = fakeRepo();
    repo.rootUri = { fsPath: root };

    // Complete history: a parentless commit really is the root commit.
    await listCommitFiles(repo as any, { hash: 'ROOT', message: 'init', parents: [] });
    assert.deepEqual(repo.calls[0], ['diff', EMPTY_TREE, 'ROOT']);

    // depth=1 clone: git grafts the boundary so it reports no parents either. Diffing it
    // against the empty tree listed every file in the repository as "this commit changed".
    await writeFile(path.join(root, '.git', 'shallow'), 'deadbeef\n');
    await assert.rejects(
      listCommitFiles(repo as any, { hash: 'BOUNDARY', message: 'grafted', parents: [] }),
      /shallow/
    );
    assert.equal(repo.calls.length, 1, 'no diff may be issued for a grafted commit');

    // A linked worktree's .git is a file, and `shallow` lives in the COMMON dir — looking
    // for it beside the worktree's own git dir reports "not shallow" for every worktree.
    const wt = path.join(root, 'wt');
    const wtGitDir = path.join(root, '.git', 'worktrees', 'wt');
    await mkdir(wtGitDir, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(path.join(wtGitDir, 'commondir'), '../..\n');
    await writeFile(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);
    const wtRepo = fakeRepo();
    wtRepo.rootUri = { fsPath: wt };
    await assert.rejects(
      listCommitFiles(wtRepo as any, { hash: 'BOUNDARY', message: 'grafted', parents: [] }),
      /shallow/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a merge lists the union of its diffs against EVERY parent', async () => {
  const perParent: Record<string, any[]> = {
    P1: [{ uri: { fsPath: '/repo/t1.ts' }, status: 5 }],
    P2: [{ uri: { fsPath: '/repo/t2.ts' }, status: 5 }, { uri: { fsPath: '/repo/t1.ts' }, status: 5 }],
    P3: [{ uri: { fsPath: '/repo/m.txt' }, status: 5 }]
  };
  const repo = fakeRepo();
  repo.diffBetweenWithStats = async (ref1: string) => perParent[ref1] ?? [];

  // Against the first parent alone, everything that arrived through parents 2..N is
  // invisible — silent loss on every octopus merge, and a different file set from the
  // Graph entry and from IntelliJ for the same commit.
  const changes = await listCommitFiles(repo as any, {
    hash: 'M', message: 'merge', parents: ['P1', 'P2', 'P3']
  });
  assert.deepEqual(
    changes.map(c => c.uri.fsPath).sort(),
    ['/repo/m.txt', '/repo/t1.ts', '/repo/t2.ts'],
    'and each path appears once'
  );
});

test('a deleted file carries its pre-deletion content, marker only as fallback', async () => {
  const repo = fakeRepo({ show: (ref: string) => (ref === 'P' ? 'the old body' : undefined) });
  const change = { uri: { fsPath: '/repo/gone.ts' }, status: 6 }; // 6 = DELETED

  // IntelliJ copies the pre-deletion content on every path, and so does this tool's SCM
  // entry; Graph, PR and History emitted a bare marker, so the same deletion looked
  // different depending on which surface copied it.
  assert.equal(await readFileAtCommit(repo as any, 'H', change, ['P']), 'the old body');

  const rootCommit = fakeRepo({ show: () => undefined });
  assert.equal(
    await readFileAtCommit(rootCommit as any, 'H', change, ['P']),
    '// This file has been deleted in this change',
    'no parent still has it — fall back to the marker'
  );
});
