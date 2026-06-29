import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRestoreBase, suggestRestoreBase, type DirProbe } from '../src/restoreBase.js';

// A fake on-disk tree: the set of directories that exist (absolute paths), and
// the immediate child dirs of the root.
function probe(existingDirs: string[], childDirs: string[]): DirProbe {
  const set = new Set(existingDirs);
  return {
    isDir: (p: string) => set.has(p.replace(/\/+$/, '')),
    childDirs: () => childDirs
  };
}

test('applyRestoreBase adds and strips a leading segment', () => {
  assert.equal(applyRestoreBase({ kind: 'add', prefix: 'repo' }, 'src/a.ts'), 'repo/src/a.ts');
  assert.equal(applyRestoreBase({ kind: 'strip', segment: 'repo' }, 'repo/src/a.ts'), 'src/a.ts');
  // strip only fires when the leading segment matches
  assert.equal(applyRestoreBase({ kind: 'strip', segment: 'repo' }, 'src/a.ts'), 'src/a.ts');
});

test('suggests ADDING a missing wrapper level when files match an existing child dir', () => {
  // Workspace opened at /work; the real repo is /work/sample-web-shop. Clipboard
  // paths are src/... (copied with the repo as root). They should nest under it.
  const p = probe(['/work/sample-web-shop', '/work/sample-web-shop/src', '/work/sample-web-shop/lib'], ['sample-web-shop']);
  const s = suggestRestoreBase('/work', ['src/a.ts', 'src/b.ts', 'lib/c.ts'], p);
  assert.ok(s, 'expected a suggestion');
  assert.deepEqual(s!.base, { kind: 'add', prefix: 'sample-web-shop' });
  assert.equal(s!.matched, 3);
});

test('suggests STRIPPING a redundant wrapper level when the root is already inside it', () => {
  // Workspace opened at /work/sample-web-shop; clipboard paths carry the wrapper
  // sample-web-shop/... (copied with the parent as root). Drop it.
  const p = probe(['/work/sample-web-shop/src', '/work/sample-web-shop/lib'], ['src', 'lib']);
  const s = suggestRestoreBase('/work/sample-web-shop', ['sample-web-shop/src/a.ts', 'sample-web-shop/lib/c.ts'], p);
  assert.ok(s, 'expected a suggestion');
  assert.deepEqual(s!.base, { kind: 'strip', segment: 'sample-web-shop' });
});

test('no suggestion when the paths already align with the workspace', () => {
  const p = probe(['/work/src', '/work/lib'], ['src', 'lib']);
  const s = suggestRestoreBase('/work', ['src/a.ts', 'lib/c.ts'], p);
  assert.equal(s, undefined);
});

test('no suggestion when nothing matches any interpretation', () => {
  const p = probe([], []); // empty target
  const s = suggestRestoreBase('/work', ['src/a.ts', 'lib/c.ts'], p);
  assert.equal(s, undefined);
});

test('no suggestion from root-level-only paths (no subdir signal)', () => {
  const p = probe(['/work/sample-web-shop'], ['sample-web-shop']);
  const s = suggestRestoreBase('/work', ['a.ts', 'README.md'], p);
  assert.equal(s, undefined);
});

test('no suggestion when two child dirs match equally well (ambiguous add)', () => {
  // /work contains repo-a/src and repo-b/src; clipboard src/... fits both → ambiguous.
  const p = probe(['/work/repo-a', '/work/repo-a/src', '/work/repo-b', '/work/repo-b/src'], ['repo-a', 'repo-b']);
  const s = suggestRestoreBase('/work', ['src/a.ts', 'src/b.ts'], p);
  assert.equal(s, undefined);
});

test('does not strip a legitimately-named top folder that is not the workspace name', () => {
  // root basename is "work"; leading segment "examples" != "work" → must NOT strip,
  // even though /work/src and /work/lib exist and stripping would "fit".
  const p = probe(['/work/src', '/work/lib'], ['src', 'lib']);
  const s = suggestRestoreBase('/work', ['examples/src/a.ts', 'examples/lib/b.ts'], p);
  assert.equal(s, undefined);
});

test('no suggestion from a single subdir-bearing path', () => {
  const p = probe(['/work/sample-web-shop', '/work/sample-web-shop/src'], ['sample-web-shop']);
  const s = suggestRestoreBase('/work', ['src/a.ts'], p);
  assert.equal(s, undefined);
});

test('requires a majority match, not a single coincidental hit', () => {
  // Only 1 of 4 files would land in an existing dir under the add base → not confident.
  const p = probe(['/work/sample-web-shop', '/work/sample-web-shop/src'], ['sample-web-shop']);
  const s = suggestRestoreBase('/work', ['src/a.ts', 'lib/b.ts', 'app/c.ts', 'web/d.ts'], p);
  assert.equal(s, undefined);
});
