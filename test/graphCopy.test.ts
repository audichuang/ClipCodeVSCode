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
  assert.deepEqual(r.skippedFiles, [{ path: 'b.ts', bytes: 2 * 1024 }]);
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

test('committed copy works via readBatch even when resolveRepo cannot match (SSH/symlink path mismatch)', async () => {
  // The graph proved the repo by showing its commits; the cat-file batch reads
  // `git -C <root>` directly, so a vscode.git path mismatch must NOT block the copy.
  const d: GraphCopyDeps = {
    resolveRepo: () => undefined, // vscode.git knows the repo under a different path → no match
    readBatch: async (_root, _hash, paths) => new Map(paths.map(p => [p, `batched ${p}`])),
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: 'abc',
    files: [{ repoRootFsPath: '/realpath/repo', relativePath: 'a.ts', status: 'M' }]
  });
  assert.equal(r.copiedFileCount, 1);
  assert.equal(r.missingRepoCount, 0);
  assert.match(r.text, /batched a\.ts/);
});

test('uncommitted copy works via readWorking even when resolveRepo cannot match', async () => {
  const d: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readWorking: async (abs: string) => (abs === '/realpath/repo/a.ts' ? 'WORKING' : undefined),
    settings
  };
  const r = await buildGraphCopyPayload(d, {
    hash: UNCOMMITTED_HASH,
    files: [{ repoRootFsPath: '/realpath/repo', relativePath: 'a.ts', status: 'M' }]
  });
  assert.equal(r.copiedFileCount, 1);
  assert.match(r.text, /WORKING/);
});

test('two repositories with the same relative path keep their identities', async () => {
  const r1 = fakeRepo('/r1', { 'a.txt': 'ONE' });
  const r2 = fakeRepo('/r2', { 'a.txt': 'TWO' });
  const deps: GraphCopyDeps = {
    resolveRepo: (root: string) => (root === '/r1' ? r1 : root === '/r2' ? r2 : undefined),
    workspaceRoots: ['/r1', '/r2'],
    settings
  };

  // Emitting both as a bare `a.txt` produced two identical headers, and restore then
  // pointed both at one destination — the second repository's file was never written.
  const result = await buildGraphCopyPayload(deps, {
    hash: 'abc', files: [
      { repoRootFsPath: '/r1', relativePath: 'a.txt', status: 'M' },
      { repoRootFsPath: '/r2', relativePath: 'a.txt', status: 'M' }
    ]
  });

  // Deliberately inverted: labelling EVERY repo fixed the collision with a scheme no
  // other surface uses and restore cannot read back — `r1/a.txt` resolved to
  // `/r1/r1/a.txt`. The workspace-root rule the other copy paths use leaves the PRIMARY
  // root unlabelled and labels the rest: no collision, and it round-trips.
  assert.match(result.text, /\/\/ file: \[MODIFIED\] a\.txt/);
  assert.doesNotMatch(result.text, /\[MODIFIED\] r1\/a\.txt/);
  assert.match(result.text, /\/\/ file: \[MODIFIED\] r2\/a\.txt/);
  assert.equal(result.copiedFileCount, 2);
});

test('a SINGLE-repo graph copy filters against the workspace-relative path, like SCM', async () => {
  // The header here is repo-relative (`secret.txt`) and must stay that way — the
  // `clipcode-root` line names that repo, and the name and the paths have to describe the
  // same base. But the user's rules are written against what every other surface shows
  // them, which is workspace-relative (`beta/secret.txt`). Filtering on the header meant an
  // EXCLUDE rule for a non-primary root silently did nothing on this one surface.
  const beta = fakeRepo('/r2', { 'secret.txt': 'SECRET', 'a.txt': 'ok' });
  const filtered: GraphCopyDeps = {
    resolveRepo: (root: string) => (root === '/r2' ? beta : undefined),
    workspaceRoots: ['/r1', '/r2'],
    settings: {
      ...settings,
      useFilters: true,
      useExcludeFilters: true,
      filterRules: [{ type: 'PATH', action: 'EXCLUDE', value: 'r2/secret.txt', enabled: true }]
    }
  };

  const result = await buildGraphCopyPayload(filtered, {
    hash: 'abc', files: [
      { repoRootFsPath: '/r2', relativePath: 'secret.txt', status: 'M' },
      { repoRootFsPath: '/r2', relativePath: 'a.txt', status: 'M' }
    ]
  });

  assert.doesNotMatch(result.text, /SECRET/);
  assert.equal(result.copiedFileCount, 1);
  // The header stays repo-relative, and the root line still names the repo.
  assert.match(result.text, /\/\/ file: \[MODIFIED\] a\.txt/);
  assert.match(result.text, /\/\/ clipcode-root: r2/);
});

test('a relative PATH rule matches on the graph surface exactly as it does on SCM', async () => {
  // The real divergence: SCM/History label via the workspace roots, which leave the PRIMARY
  // root's files UNLABELLED (`secret.txt`), while the graph surface prefixed every repo
  // (`r1/secret.txt`). An `EXCLUDE PATH secret.txt` rule therefore held everywhere except
  // here — the same rule, the same repo, the secret on the clipboard.
  const r1 = fakeRepo('/r1', { 'secret.txt': 'SECRET', 'a.txt': 'ok' });
  const r2 = fakeRepo('/r2', { 'a.txt': 'ok' });
  const filtered: GraphCopyDeps = {
    resolveRepo: (root: string) => (root === '/r1' ? r1 : root === '/r2' ? r2 : undefined),
    workspaceRoots: ['/r1', '/r2'],
    settings: {
      ...settings,
      useFilters: true,
      useExcludeFilters: true,
      filterRules: [{ type: 'PATH', action: 'EXCLUDE', value: 'secret.txt', enabled: true }]
    }
  };

  const result = await buildGraphCopyPayload(filtered, {
    hash: 'abc', files: [
      { repoRootFsPath: '/r1', relativePath: 'secret.txt', status: 'M' },
      { repoRootFsPath: '/r1', relativePath: 'a.txt', status: 'M' },
      { repoRootFsPath: '/r2', relativePath: 'a.txt', status: 'M' }
    ]
  });

  assert.doesNotMatch(result.text, /SECRET/);
  assert.equal(result.copiedFileCount, 2);
});

test('an absolute-path filter rule still matches in a multi-repo payload', async () => {
  // The absolute path handed to the filter was built from clipboardPath, which carries the
  // repo-basename prefix once a payload spans repositories — so the rule was tested against
  // `/r1/r1/secrets.env`, a path that exists nowhere, and every absolute PATH rule silently
  // stopped matching exactly where the prefix appears.
  const r1 = fakeRepo('/r1', { 'secrets.env': 'SECRET', 'a.txt': 'ok' });
  const r2 = fakeRepo('/r2', { 'a.txt': 'ok' });
  const filtered: GraphCopyDeps = {
    resolveRepo: (root: string) => (root === '/r1' ? r1 : root === '/r2' ? r2 : undefined),
    workspaceRoots: ['/r1', '/r2'],
    settings: {
      ...settings,
      useFilters: true,
      useExcludeFilters: true,
      filterRules: [{ type: 'PATH', action: 'EXCLUDE', value: '/r1/secrets.env', enabled: true }]
    }
  };

  const result = await buildGraphCopyPayload(filtered, {
    hash: 'abc', files: [
      { repoRootFsPath: '/r1', relativePath: 'secrets.env', status: 'M' },
      { repoRootFsPath: '/r1', relativePath: 'a.txt', status: 'M' },
      { repoRootFsPath: '/r2', relativePath: 'a.txt', status: 'M' }
    ]
  });

  assert.doesNotMatch(result.text, /SECRET/);
  assert.match(result.text, /\/\/ file: \[MODIFIED\] a\.txt/);
  assert.match(result.text, /r2\/a\.txt/);
  assert.equal(result.copiedFileCount, 2);
});

test('the graph surface honours the ordinary exclude filters', async () => {
  const repo = fakeRepo('/repo', { 'secrets.env': 'SECRET', 'src/a.ts': 'ok' });
  const filtered: GraphCopyDeps = {
    resolveRepo: (root: string) => (root === '/repo' ? repo : undefined),
    // The same rule held on the SCM and History entries and silently did nothing here.
    settings: {
      ...settings,
      useFilters: true,
      useExcludeFilters: true,
      filterRules: [{ type: 'PATH', action: 'EXCLUDE', value: 'secrets.env', enabled: true }]
    }
  };

  const result = await buildGraphCopyPayload(filtered, {
    hash: 'abc', files: [
      { repoRootFsPath: '/repo', relativePath: 'secrets.env', status: 'M' },
      { repoRootFsPath: '/repo', relativePath: 'src/a.ts', status: 'M' }
    ]
  });

  assert.doesNotMatch(result.text, /SECRET/);
  assert.match(result.text, /src\/a\.ts/);
  assert.equal(result.copiedFileCount, 1);
});
