import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClipboard } from '../src/clipboardFormat.js';
import { readRefClassified, type ContentRepo } from '../src/gitContent.js';
import { buildGraphCopyPayload, type GraphCopyDeps, type GraphCopySettings } from '../src/graphCopy.js';
import { collectHistoryCopy } from '../src/historyCopy.js';
import type { FileNode } from '../src/historyTree.js';
import { askAboutNonText, type NonTextChoice } from '../src/nonTextDialog.js';
import { parseBody } from '../src/nonText.js';
import { defaultSettings } from '../src/settings.js';

// Non-text files on the Git commit surfaces: Graph / PR / Recent Commits (copyFullSourceAtCommit
// → buildGraphCopyPayload), the History view, and the shared Include / Exclude / Cancel flow.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const BIG5 = new Uint8Array([0xa4, 0xe9, 0xa5, 0xbb]);

const graphSettings: GraphCopySettings = {
  headerFormat: '// file: $FILE_PATH',
  preText: '',
  postText: '',
  addExtraLineBetweenFiles: true,
  maxFileSizeKB: 500,
  fileCountLimit: 30,
  setMaxFileCount: false
};

function graphDeps(blobs: Record<string, Uint8Array | string>, settings = graphSettings, repo?: ContentRepo): GraphCopyDeps {
  return {
    resolveRepo: () => repo,
    // The real reader is `git cat-file --batch` through parseCatFileBatch: text or raw bytes.
    readBatch: async (_root, _hash, paths) => new Map(paths.filter(p => p in blobs).map(p => {
      const blob = blobs[p];
      return [p, typeof blob === 'string' ? { text: blob } : { nonText: blob }];
    })),
    settings
  };
}

function bodies(text: string): Map<string, string> {
  return new Map(parseClipboard(text, graphSettings.headerFormat).map(e => [e.path, e.content]));
}

test('Graph Include carries non-text blobs as verified Base64; Exclude is the old payload', async () => {
  const blobs = { 'img/logo.png': PNG, 'legacy.csv': BIG5, 'a.ts': 'hello' };
  const files = ['img/logo.png', 'legacy.csv', 'a.ts'].map(relativePath => ({ repoRootFsPath: '/repo', relativePath, status: 'A' }));
  const include = await buildGraphCopyPayload(graphDeps(blobs), { hash: 'abc', files }, { includeNonText: true });

  assert.equal(include.copiedFileCount, 3);
  assert.deepEqual(include.nonTextFiles, [{ path: 'img/logo.png', size: PNG.length }, { path: 'legacy.csv', size: BIG5.length }]);
  assert.equal(include.nonTextTotalBytes, PNG.length + BIG5.length);
  assert.equal(include.estimatedBytes, Buffer.byteLength(include.text, 'utf8'));
  const parsed = bodies(include.text);
  assert.deepEqual(parseBody(parsed.get('img/logo.png')!), { bytes: PNG });
  assert.deepEqual(parseBody(parsed.get('legacy.csv')!), { bytes: BIG5 });

  // Exclude (and the old default call) drop them and count them, as before non-text support.
  const exclude = await buildGraphCopyPayload(graphDeps(blobs), { hash: 'abc', files }, { includeNonText: false });
  const legacy = await buildGraphCopyPayload(graphDeps(blobs), { hash: 'abc', files });
  const textOnly = await buildGraphCopyPayload(graphDeps({ 'a.ts': 'hello' }), { hash: 'abc', files: [files[2]] });
  assert.equal(exclude.text, legacy.text);
  assert.equal(exclude.text, textOnly.text);
  assert.equal(exclude.skippedUnreadableCount, 2);
  assert.equal(exclude.excludedNonTextCount, 2);
  assert.deepEqual(exclude.nonTextFiles, []);
});

test('Graph Include: over the non-text limit is a size placeholder; a deleted non-text file keeps the marker', async () => {
  const big = new Uint8Array(3 * 1024).fill(0);
  // The deleted file's parent revision still holds the image bytes.
  const repo: ContentRepo = { rootUri: { fsPath: '/repo' }, buffer: async () => PNG };
  const result = await buildGraphCopyPayload(
    graphDeps({ 'big.png': big }, { ...graphSettings, maxNonTextFileSizeKB: 2 }, repo),
    { hash: 'abc', files: [
      { repoRootFsPath: '/repo', relativePath: 'big.png', status: 'M' },
      { repoRootFsPath: '/repo', relativePath: 'gone.png', status: 'D' }
    ] },
    { includeNonText: true });
  const parsed = bodies(result.text);
  assert.equal(parsed.get('big.png'), '// File skipped: size exceeds limit (3072 bytes)');
  assert.equal(parsed.get('gone.png'), '// This file has been deleted in this change');
  assert.equal(result.nonTextOverLimitCount, 1);
  assert.deepEqual(result.nonTextFiles, []);
});

test('Graph Include: the uncommitted view and the per-file fallback carry bytes too', async () => {
  const working = await buildGraphCopyPayload({
    resolveRepo: () => undefined,
    readWorking: async () => ({ nonText: PNG }),
    settings: graphSettings
  }, { hash: 'UNCOMMITTED', files: [{ repoRootFsPath: '/repo', relativePath: 'new.png', status: 'U' }] }, { includeNonText: true });
  assert.deepEqual(working.nonTextFiles, [{ path: 'new.png', size: PNG.length }]);

  // cat-file spawn failed (no readBatch): readRefClassified via the Git API's buffer().
  const repo: ContentRepo = { rootUri: { fsPath: '/repo' }, buffer: async () => BIG5 };
  const fallback = await buildGraphCopyPayload({ resolveRepo: () => repo, settings: graphSettings },
    { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'b.csv', status: 'M' }] }, { includeNonText: true });
  assert.deepEqual(fallback.nonTextFiles, [{ path: 'b.csv', size: BIG5.length }]);
});

test('Graph: the file-count limit counts non-text files and reports what it left out', async () => {
  const blobs = { 'a.png': PNG, 'b.png': PNG, 'c.png': PNG, 'd.ts': 'x' };
  const files = Object.keys(blobs).map(relativePath => ({ repoRootFsPath: '/repo', relativePath, status: 'A' }));
  const result = await buildGraphCopyPayload(graphDeps(blobs, { ...graphSettings, setMaxFileCount: true, fileCountLimit: 2 }),
    { hash: 'abc', files }, { includeNonText: true });
  assert.deepEqual(result.nonTextFiles.map(f => f.path), ['a.png', 'b.png']);
  assert.equal(result.fileLimitReached, true);
  assert.equal(result.limitLeftOut, 2);
});

test('readRefClassified returns a non-text blob as bytes; readRefContent-style text stays text', async () => {
  const repo: ContentRepo = { rootUri: { fsPath: '/repo' }, buffer: async (_ref, p) => (p === 'img.png' ? PNG : new TextEncoder().encode('t')) };
  assert.deepEqual(await readRefClassified(repo, 'HEAD', '/repo/img.png'), { nonText: PNG });
  assert.deepEqual(await readRefClassified(repo, 'HEAD', '/repo/a.ts'), { text: 't' });
});

function historyFile(name: string, status: string): FileNode {
  return {
    kind: 'file', repoRoot: '/repo', relPath: name, name,
    commit: { hash: 'h', message: 'm', parents: ['p'] },
    change: { uri: { fsPath: `/repo/${name}` }, status },
    changeType: status === 'DELETED' ? 'DELETED' : 'MODIFIED'
  };
}

test('History Include carries non-text files; Exclude names them unresolved as before', async () => {
  const files = [historyFile('logo.png', 'MODIFIED'), historyFile('a.ts', 'MODIFIED')];
  const read = async (f: FileNode) => (f.name === 'logo.png' ? { nonText: PNG } : { text: 'hello' });
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat };

  const include = await collectHistoryCopy(files, read, settings, ['/repo'], { includeNonText: true });
  assert.deepEqual(include.files, [
    { path: 'logo.png', nonText: PNG, changeType: 'MODIFIED' },
    { path: 'a.ts', content: 'hello', changeType: 'MODIFIED' }
  ]);
  assert.deepEqual(include.unresolved, []);
  assert.deepEqual(parseBody(bodies(include.payload).get('logo.png')!), { bytes: PNG });

  const exclude = await collectHistoryCopy(files, read, settings, ['/repo'], { includeNonText: false });
  assert.deepEqual(exclude.files, [{ path: 'a.ts', content: 'hello', changeType: 'MODIFIED' }]);
  assert.deepEqual(exclude.unresolved, ['logo.png']);
  assert.equal(exclude.excludedNonTextCount, 1);
});

test('History Include: a non-text file over its limit is a size placeholder; the limit reports what it left out', async () => {
  const files = [historyFile('a.png', 'MODIFIED'), historyFile('b.png', 'MODIFIED'), historyFile('c.png', 'MODIFIED')];
  const read = async (f: FileNode) => ({ nonText: f.name === 'a.png' ? new Uint8Array(3 * 1024) : PNG });
  const result = await collectHistoryCopy(files, read,
    { ...defaultSettings, maxNonTextFileSizeKB: 2, setMaxFileCount: true, fileCountLimit: 1 }, ['/repo'], { includeNonText: true });
  assert.deepEqual(result.files.map(f => f.skippedReason ?? f.path), ['size exceeds limit (3072 bytes)', 'b.png']);
  assert.equal(result.nonTextOverLimitCount, 1);
  assert.equal(result.limitLeftOut, 1);
});

/** A summary with [n] non-text files, tagged so the test can see which run it came from. */
function summary(includeNonText: boolean, n: number) {
  return {
    includeNonText,
    nonTextFiles: Array.from({ length: n }, (_, i) => ({ path: `f${i}.png`, size: 1 })),
    nonTextTotalBytes: n, nonTextOverLimitCount: 0, unreadOverLimitCount: 0, limitLeftOut: 0, estimatedBytes: 10
  };
}

test('askAboutNonText: no dialog without non-text files; Include, Exclude and Cancel pick the run', async () => {
  const shown: NonTextChoice[][] = [];
  const answer = (choice: NonTextChoice | undefined) => async (_m: string, _o: unknown, ...buttons: NonTextChoice[]) => {
    shown.push(buttons);
    return choice;
  };
  const run = (n: number) => async (includeNonText: boolean) => summary(includeNonText, n);
  const settings = { headerFormat: '// file: $FILE_PATH' };

  assert.equal((await askAboutNonText(settings, run(0), answer('Include')))?.includeNonText, true);
  assert.equal(shown.length, 0, 'a copy without non-text files never asks');

  assert.equal((await askAboutNonText(settings, run(2), answer('Include')))?.includeNonText, true);
  assert.equal((await askAboutNonText(settings, run(2), answer('Exclude')))?.includeNonText, false);
  assert.equal(await askAboutNonText(settings, run(2), answer(undefined)), undefined);
  assert.deepEqual(shown, [['Include', 'Exclude'], ['Include', 'Exclude'], ['Include', 'Exclude']]);

  // Case 25: an unescapable header format offers Exclude only.
  shown.length = 0;
  assert.equal(await askAboutNonText({ headerFormat: '$FILE_PATH' }, run(1), answer('Include')), undefined);
  assert.deepEqual(shown, [['Exclude']]);
});
