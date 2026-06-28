import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphCopyPayload, UNCOMMITTED_HASH, type GraphCopyDeps, type GraphCopySettings } from '../src/graphCopy.js';
import type { ContentRepo } from '../src/gitContent.js';

const settings: GraphCopySettings = {
  headerFormat: '// file: $FILE_PATH',
  preText: '',
  postText: '',
  addExtraLineBetweenFiles: true,
  maxFileSizeKB: 500,
  fileCountLimit: 30,
  setMaxFileCount: false
};

function fakeRepo(root: string, contentByPath: Record<string, string>): ContentRepo {
  return {
    rootUri: { fsPath: root },
    show: async (_ref: string, p: string) => contentByPath[p.replaceAll('\\', '/')]
  };
}

const deps = (repo: ContentRepo): GraphCopyDeps => ({
  resolveRepo: (root: string) => (root === '/repo' ? repo : undefined),
  settings
});

test('modified file reads content at commit', async () => {
  const repo = fakeRepo('/repo', { 'a.ts': 'hello' });
  const r = await buildGraphCopyPayload(deps(repo), {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'a.ts', status: 'M' }]
  });
  assert.equal(r.copiedFileCount, 1);
  assert.match(r.text, /\/\/ file: \[MODIFIED\] a\.ts/);
  assert.match(r.text, /hello/);
});

test('deleted file uses marker without reading', async () => {
  const repo = fakeRepo('/repo', {});
  const r = await buildGraphCopyPayload(deps(repo), {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'gone.ts', status: 'D' }]
  });
  assert.match(r.text, /\[DELETED\] gone\.ts/);
  assert.match(r.text, /This file has been deleted/);
});

test('rename status R100 maps to MOVED label', async () => {
  const repo = fakeRepo('/repo', { 'new.ts': 'x' });
  const r = await buildGraphCopyPayload(deps(repo), {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'new.ts', oldRelativePath: 'old.ts', status: 'R100' }]
  });
  assert.match(r.text, /\[MOVED\] new\.ts/);
});

test('missing repo is counted, not crashed', async () => {
  const repo = fakeRepo('/repo', {});
  const r = await buildGraphCopyPayload(deps(repo), {
    hash: 'abc',
    files: [{ repoRootFsPath: '/other', relativePath: 'a.ts', status: 'M' }]
  });
  assert.equal(r.missingRepoCount, 1);
  assert.equal(r.copiedFileCount, 0);
});

test('oversize file is skipped with reason', async () => {
  const big = 'x'.repeat(2 * 1024);
  const repo = fakeRepo('/repo', { 'b.ts': big });
  const small: GraphCopySettings = { ...settings, maxFileSizeKB: 1 };
  const d: GraphCopyDeps = { resolveRepo: () => repo, settings: small };
  const r = await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'b.ts', status: 'M' }]
  });
  assert.equal(r.skippedFileSizeCount, 1);
  assert.match(r.text, /File skipped: size exceeds limit/);
});

test('binary/unreadable (undefined content) is skipped silently', async () => {
  const repo: ContentRepo = { rootUri: { fsPath: '/repo' }, show: async () => undefined as unknown as string };
  const r = await buildGraphCopyPayload({ resolveRepo: () => repo, settings }, {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'img.png', status: 'M' }]
  });
  assert.equal(r.copiedFileCount, 0);
  assert.equal(r.skippedFileSizeCount, 0);
});

test('UNCOMMITTED hash reads working-tree content via readWorking, not git show', async () => {
  const repo = fakeRepo('/repo', { 'a.ts': 'COMMITTED' }); // git show must NOT be used
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readWorking: async (abs: string) => (abs === '/repo/a.ts' ? 'WORKING' : undefined),
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: UNCOMMITTED_HASH,
    files: [{ repoRootFsPath: '/repo', relativePath: 'a.ts', status: 'U' }] // untracked -> NEW
  });
  assert.equal(r.copiedFileCount, 1);
  assert.match(r.text, /\/\/ file: \[NEW\] a\.ts/); // git-graph-plus untracked status 'U' maps to NEW
  assert.match(r.text, /WORKING/);
  assert.doesNotMatch(r.text, /COMMITTED/);
});

test('UNCOMMITTED deleted file still uses marker (no working read)', async () => {
  const repo = fakeRepo('/repo', {});
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readWorking: async () => { throw new Error('should not read a deleted file'); },
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: UNCOMMITTED_HASH,
    files: [{ repoRootFsPath: '/repo', relativePath: 'gone.ts', status: 'D' }]
  });
  assert.match(r.text, /\[DELETED\] gone\.ts/);
  assert.match(r.text, /This file has been deleted/);
});
