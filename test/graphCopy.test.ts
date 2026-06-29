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

test('reads run concurrently and preserve input order (no per-file serialization)', async () => {
  // The slow part of a real copy is one `git show` subprocess per file. With many
  // files those reads must overlap, not run strictly one-after-another.
  let inFlight = 0;
  let maxInFlight = 0;
  const files = Array.from({ length: 8 }, (_, i) => ({
    repoRootFsPath: '/repo',
    relativePath: `f${i}.ts`,
    status: 'M'
  }));
  const repo: ContentRepo = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return `body-${p}`;
    }
  };
  const r = await buildGraphCopyPayload(deps(repo), { hash: 'abc', files });

  assert.equal(r.copiedFileCount, 8);
  assert.ok(maxInFlight >= 2, `expected overlapping reads, but max in-flight was ${maxInFlight}`);
  // Concurrency must not reorder the output.
  const order = [...r.text.matchAll(/\[MODIFIED\] (f\d+\.ts)/g)].map(m => m[1]);
  assert.deepEqual(order, files.map(f => f.relativePath));
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

test('committed view reads all content via one readBatch call, not per-file show', async () => {
  let showCalls = 0;
  let batchCalls = 0;
  const repo: ContentRepo = {
    rootUri: { fsPath: '/repo' },
    show: async () => { showCalls++; return 'SHOULD-NOT-BE-USED'; }
  };
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readBatch: async (_root, _hash, paths) => { batchCalls++; return new Map(paths.map(p => [p, `batched ${p}`])); },
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: [
      { repoRootFsPath: '/repo', relativePath: 'a.ts', status: 'M' },
      { repoRootFsPath: '/repo', relativePath: 'b.ts', status: 'M' }
    ]
  });
  assert.equal(batchCalls, 1);   // one cat-file batch for the whole repo
  assert.equal(showCalls, 0);    // no per-file git show
  assert.equal(r.copiedFileCount, 2);
  assert.match(r.text, /batched a\.ts/);
  assert.match(r.text, /batched b\.ts/);
});

test('a path containing a newline is kept out of the batch and read per-file', async () => {
  // cat-file --batch is newline-delimited; a path with a line break would corrupt
  // request/response alignment, so it must go to the per-file reader instead.
  const requestedBatches: string[][] = [];
  let showCalls = 0;
  const repo: ContentRepo = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => { showCalls++; return `shown ${p.replace(/\n/g, '<NL>')}`; }
  };
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readBatch: async (_root, _hash, paths) => { requestedBatches.push(paths); return new Map(paths.map(p => [p, `batched ${p}`])); },
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: [
      { repoRootFsPath: '/repo', relativePath: 'ok.ts', status: 'M' },
      { repoRootFsPath: '/repo', relativePath: 'weird\nname.ts', status: 'M' }
    ]
  });
  assert.deepEqual(requestedBatches, [['ok.ts']]);     // newline path excluded from the batch
  assert.equal(showCalls, 1);                          // it fell back to a per-file read
  assert.match(r.text, /batched ok\.ts/);
  assert.match(r.text, /shown weird<NL>name\.ts/);
});

test('batch request is capped at the file-count limit (no reading past it)', async () => {
  const requestedBatches: string[][] = [];
  const repo: ContentRepo = { rootUri: { fsPath: '/repo' }, show: async () => 'x' };
  const limited: GraphCopySettings = { ...settings, setMaxFileCount: true, fileCountLimit: 2 };
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readBatch: async (_root, _hash, paths) => { requestedBatches.push(paths); return new Map(paths.map(p => [p, p])); },
    settings: limited
  };
  await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: Array.from({ length: 5 }, (_, i) => ({ repoRootFsPath: '/repo', relativePath: `f${i}.ts`, status: 'M' }))
  });
  assert.deepEqual(requestedBatches, [['f0.ts', 'f1.ts']]); // only up to the limit was fetched
});

test('falls back to per-file show when readBatch yields nothing (spawn failure)', async () => {
  let showCalls = 0;
  const repo: ContentRepo = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => { showCalls++; return `shown ${p}`; }
  };
  const d: GraphCopyDeps = {
    resolveRepo: () => repo,
    readBatch: async () => new Map(), // cat-file spawn failed → empty → fall back
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: [{ repoRootFsPath: '/repo', relativePath: 'a.ts', status: 'M' }]
  });
  assert.equal(showCalls, 1);
  assert.equal(r.copiedFileCount, 1);
  assert.match(r.text, /shown a\.ts/);
});
