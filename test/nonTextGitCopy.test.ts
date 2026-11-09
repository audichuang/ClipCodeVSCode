import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClipboard } from '../src/clipboardFormat.js';
import { readRefClassified, type ContentRepo } from '../src/gitContent.js';
import { buildGraphCopyPayload, type GraphCopyDeps, type GraphCopySettings } from '../src/graphCopy.js';
import { collectHistoryCopy, historyCopyNotice } from '../src/historyCopy.js';
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

test('History Include carries non-text files; Exclude counts them as left out, not unresolved', async () => {
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
  // A non-text file left out on purpose was read fine: it is not "could not be resolved".
  assert.deepEqual(exclude.unresolved, []);
  assert.equal(exclude.excludedNonTextCount, 1);
});

test('History notice: says how many files the limit left out and reports excluded non-text files apart', async () => {
  const files = [
    historyFile('logo.png', 'MODIFIED'), historyFile('gone.ts', 'MODIFIED'),
    historyFile('a.ts', 'MODIFIED'), historyFile('b.ts', 'MODIFIED'), historyFile('c.ts', 'MODIFIED')
  ];
  const read = async (f: FileNode) =>
    f.name === 'logo.png' ? { nonText: PNG } : f.name === 'gone.ts' ? undefined : { text: 'hello' };
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat, setMaxFileCount: true, fileCountLimit: 1 };

  const exclude = await collectHistoryCopy(files, read, settings, ['/repo'], { includeNonText: false });
  assert.deepEqual(historyCopyNotice(exclude, settings), {
    unresolvedWarning: '1 files could not be resolved: gone.ts',
    message: '1 Git file(s) copied. File limit 1 reached. Non-text files left out: 1. Left out by the file-count limit: 2.',
    // Something was copied: no empty warning.
    emptyWarning: undefined
  });

  const include = await collectHistoryCopy(files, read, settings, ['/repo'], { includeNonText: true });
  assert.deepEqual(historyCopyNotice(include, settings), {
    unresolvedWarning: undefined,
    message: '1 Git file(s) copied. File limit 1 reached. Non-text files copied as Base64: 1. Left out by the file-count limit: 4.',
    // Something was copied: no empty warning.
    emptyWarning: undefined
  });
});

test('case 30 on History: every selected file unreadable gives one "Nothing to copy." warning naming them', async () => {
  const files = [historyFile('src/gone.ts', 'MODIFIED'), historyFile('lost.ts', 'MODIFIED')];
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat };
  const result = await collectHistoryCopy(files, async () => undefined, settings, ['/repo']);
  assert.deepEqual(historyCopyNotice(result, settings), {
    // Not a second toast: the empty warning already names them.
    unresolvedWarning: undefined,
    message: '0 Git file(s) copied.',
    emptyWarning: 'Nothing to copy. Unreadable: 2 (src/gone.ts, lost.ts).'
  });
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

test('X2: every surface\'s shared flow leaves Include out when its estimate is over 50 MiB', async () => {
  const shown: NonTextChoice[][] = [];
  const answer = (choice: NonTextChoice | undefined) => async (_m: string, _o: unknown, ...buttons: NonTextChoice[]) => {
    shown.push(buttons);
    return choice;
  };
  const settings = { headerFormat: '// file: $FILE_PATH' };
  const sized = (estimatedBytes: number) => async (includeNonText: boolean) => ({ ...summary(includeNonText, 1), estimatedBytes });

  // The real 50 MiB limit, no override: one byte over leaves only Exclude; a stray Include is Cancel.
  assert.equal(await askAboutNonText(settings, sized(52_428_801), answer('Include')), undefined);
  assert.equal((await askAboutNonText(settings, sized(52_428_801), answer('Exclude')))?.includeNonText, false);
  // Exactly 50 MiB is within the limit.
  assert.equal((await askAboutNonText(settings, sized(52_428_800), answer('Include')))?.includeNonText, true);
  assert.deepEqual(shown, [['Exclude'], ['Exclude'], ['Include', 'Exclude']]);

  // The limit is injectable.
  shown.length = 0;
  assert.equal(await askAboutNonText(settings, sized(11), answer('Include'), { payloadLimitBytes: 10 }), undefined);
  assert.equal((await askAboutNonText(settings, sized(10), answer('Include'), { payloadLimitBytes: 10 }))?.includeNonText, true);
  assert.deepEqual(shown, [['Exclude'], ['Include', 'Exclude']]);
});

test('Graph: the left-out count stops at the cap; exactly the cap reads plain; unreadable blobs are named', async () => {
  const blobs: Record<string, string> = {};
  const names = Array.from({ length: 7 }, (_, i) => `f${i}.ts`);
  for (const n of names.slice(0, 6)) blobs[n] = 'x';
  const files = names.map(relativePath => ({ repoRootFsPath: '/repo', relativePath, status: 'A' }));
  const settings = { ...graphSettings, setMaxFileCount: true, fileCountLimit: 1 };
  const run = (leftOutCap: number) => buildGraphCopyPayload(graphDeps(blobs, settings), { hash: 'abc', files }, { includeNonText: true, leftOutCap });

  // 6 files past the limit.
  const capped = await run(5);
  assert.deepEqual([capped.limitLeftOut, capped.limitLeftOutCapped], [5, true]);
  const exact = await run(6);
  assert.deepEqual([exact.limitLeftOut, exact.limitLeftOutCapped], [6, false]);
  assert.equal(capped.text, exact.text);

  // The uncommitted view reads the working tree: one unreadable file is named.
  const open = await buildGraphCopyPayload({
    resolveRepo: () => undefined,
    readWorking: async (absolutePath: string) => (absolutePath.endsWith('/f6.ts') ? undefined : { text: 'x' }),
    settings: graphSettings
  }, { hash: 'UNCOMMITTED', files }, { includeNonText: true });
  assert.deepEqual(open.unreadablePaths, ['f6.ts']);
});

test('History: the left-out count is capped, exactly the cap reads plain, and the notice shows N+', async () => {
  const files = Array.from({ length: 6 }, (_, i) => historyFile(`f${i}.ts`, 'MODIFIED'));
  const read = async () => ({ text: 'x' });
  const settings = { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 1 };
  const run = (leftOutCap: number) => collectHistoryCopy(files, read, settings, ['/repo'], { includeNonText: true, leftOutCap });
  // 5 files past the limit.
  const capped = await run(4);
  assert.deepEqual([capped.limitLeftOut, capped.limitLeftOutCapped], [4, true]);
  assert.match(historyCopyNotice(capped, settings).message, /Left out by the file-count limit: 4\+\./);
  const exact = await run(5);
  assert.deepEqual([exact.limitLeftOut, exact.limitLeftOutCapped], [5, false]);
  assert.match(historyCopyNotice(exact, settings).message, /Left out by the file-count limit: 5\./);
});
