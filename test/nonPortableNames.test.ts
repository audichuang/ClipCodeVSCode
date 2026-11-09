import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCopyFiles } from '../src/copy.js';
import { buildGraphCopyPayload, type GraphCopyDeps } from '../src/graphCopy.js';
import { parseClipboard } from '../src/clipboardFormat.js';
import { EMPTY_TREE } from '../src/gitHistory.js';
import { collectHistoryCopy, historyCopyNotice, historyGitPaths } from '../src/historyCopy.js';
import type { FileNode } from '../src/historyTree.js';
import { copyNoticeDetails, nonTextDialog } from '../src/nonTextDialog.js';
import { isExportableRelativePath, nonPortableName } from '../src/pathResolver.js';
import { defaultSettings } from '../src/settings.js';

// Names a payload header cannot carry are skipped and named "Name not portable" (spec
// non-text-files.md "What is carried", user decision D2 of 2026-11-09). The rule is the
// paste side's sanitizer: OpenIDEA paths.rs is_exportable_relative_path.

// Windows cannot create `\`, `"`, a tab or `:` in a file name, and reads `\` as a separator.
const posixOnly = process.platform === 'win32' ? 'Windows cannot create these names' : undefined;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test('isExportableRelativePath is the paste-side sanitizer: \\ " tab : .. and edge spaces refused', () => {
  for (const bad of ['a\\b.png', 'dir/a"b.ts', 'a\tb.ts', 'a:b.ts', 'bad:dir/x.ts', '../x.ts', 'a/../x.ts',
    'x<y', 'x|y', 'x?y', 'x*y', 'a\nb', 'a\u001fb', 'a.ts ', ' a.ts', 'a//b', './a', 'a/', '/a', 'C:/a', '']) {
    assert.equal(isExportableRelativePath(bad), false, JSON.stringify(bad));
  }
  for (const good of ['a.ts', 'dir with space/file name.ts', '檔案/中文 名稱.md', 'emoji 😀/🎉.png', 'a b/c d e',
    '.hidden/.env', 'x\u0085y', 'x\u2028y', 'a.b.c/d-e_f+g=h,i;j[k]{l}(m)!@#$%^&~`']) {
    assert.equal(isExportableRelativePath(good), true, JSON.stringify(good));
  }
});

test('nonPortableName judges the real name below the root, never the slash-normalised clipboard path', { skip: posixOnly }, () => {
  // The clipboard path of `a\b.png` reads `a/b.png`; the real name is refused.
  assert.equal(nonPortableName(['/ws'], '/ws/a\\b.png'), 'a\\b.png');
  assert.equal(nonPortableName(['/ws'], '/ws/dir/q"x.ts'), 'dir/q"x.ts');
  assert.equal(nonPortableName(['/ws'], '/ws/ok name 檔 😀.ts'), undefined);
  // The root itself and a portable path under a labelled second root.
  assert.equal(nonPortableName(['/ws'], '/ws'), undefined);
  assert.equal(nonPortableName(['/ws', '/other/lib'], '/other/lib/src/a.ts'), undefined);
  // Under a labelled second root, the name keeps that label.
  assert.equal(nonPortableName(['/ws', '/other/lib'], '/other/lib/src/a:b.ts'), 'lib/src/a:b.ts');
  // Under no root the header is the absolute path (X15): a control character anywhere in
  // it, or a non-portable file NAME, refuses it; other characters in its folders do not.
  assert.equal(nonPortableName(['/ws'], '/elsewhere/dir/a.ts'), undefined);
  assert.equal(nonPortableName(['/ws'], '/else:where/a"b?/a.ts'), undefined);
  assert.equal(nonPortableName(['/ws'], '/elsewhere/q"x.ts'), '/elsewhere/q"x.ts');
  assert.equal(nonPortableName(['/ws'], '/elsewhere/a.ts '), '/elsewhere/a.ts ');
  assert.equal(nonPortableName(['/ws'], '/else\nwhere/a.ts'), '/else\nwhere/a.ts');
  assert.equal(nonPortableName(['/ws'], '/tmp/x\nfile: [DELETED] victim.txt/notes.txt'),
    '/tmp/x\nfile: [DELETED] victim.txt/notes.txt');
  assert.equal(nonPortableName(['/ws'], '/else\twhere/a.ts'), '/else\twhere/a.ts');
  // A folder outside every root: its own name, judged as a folder (a trailing space is fine).
  assert.equal(nonPortableName(['/ws'], '/elsewhere/dir ', { directory: true }), undefined);
  assert.equal(nonPortableName(['/ws'], '/elsewhere/d:ir', { directory: true }), '/elsewhere/d:ir');
  // A workspace root is never judged by the parent root that also holds it.
  assert.equal(nonPortableName(['/repo/app:one', '/repo'], '/repo/app:one', { directory: true }), undefined);
  assert.equal(nonPortableName(['/repo', '/repo/app:one'], '/repo/app:one', { directory: true }), undefined);
});

test('files copy: a selected root nested in another root is walked even when its own name is not portable', { skip: posixOnly }, async () => {
  await withTempDir(async base => {
    const repo = path.join(base, 'repo');
    const app = path.join(repo, 'app:one');
    await put(path.join(app, 'ok.ts'), 'x');
    await put(path.join(app, 'sub', 'b.ts'), 'y');
    const result = await collectCopyFiles([app, repo], [app], defaultSettings, { includeNonText: false });
    assert.deepEqual(result.nonPortablePaths, []);
    assert.deepEqual(result.files.map(f => f.path), ['ok.ts', 'sub/b.ts']);
    // With `/repo` primary the headers really are `app:one/...`: those files are refused,
    // but the root folder itself is not what gets named.
    const parentFirst = await collectCopyFiles([repo, app], [app], defaultSettings, { includeNonText: false });
    assert.deepEqual(parentFirst.nonPortablePaths, ['app:one/ok.ts', 'app:one/sub']);
  });
});

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipcode-nonportable-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test('files copy: non-portable files and folders are skipped, named with their real name, and not limited', { skip: posixOnly }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'src', 'a"quote.ts'), 'q');
    await put(path.join(root, 'src', 'back\\slash.png'), PNG);
    await put(path.join(root, 'src', 'colon:name.ts'), 'c');
    await put(path.join(root, 'src', 'tab\there.ts'), 't');
    await put(path.join(root, 'src', 'bad:dir', 'inner.ts'), 'never read');
    await put(path.join(root, 'src', 'bad:dir', 'deep', 'more.ts'), 'never read');
    await put(path.join(root, 'src', 'zz ok name 檔案 😀.ts'), 'ok');

    // A limit of 1: the five refused entries come first in the walk and must not use it up
    // (the copied file sorts last: once it fills the limit, a later skip is silent).
    const settings = { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 1 };
    const result = await collectCopyFiles(root, [path.join(root, 'src')], settings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => [f.path, f.content]), [['src/zz ok name 檔案 😀.ts', 'ok']]);
    assert.equal(result.fileLimitReached, false);
    assert.equal(result.limitLeftOut, 0);
    assert.equal(result.nonPortableCount, 5);
    // Sorted walk order; the folder is named once, its files are never listed.
    assert.deepEqual(result.nonPortablePaths, [
      'src/a"quote.ts', 'src/back\\slash.png', 'src/bad:dir', 'src/colon:name.ts', 'src/tab\there.ts'
    ]);
    // Not read, so not Unreadable either.
    assert.equal(result.skippedUnreadableCount, 0);
    assert.deepEqual(result.nonTextFiles, []);
    assert.ok(copyNoticeDetails(result).includes(
      'Name not portable: 5 (src/a"quote.ts, src/back\\slash.png, src/bad:dir and 2 more).'), copyNoticeDetails(result).join('\n'));
  });
});

test('files copy: a directly selected non-portable file or folder is named; the dialog lists the category', { skip: posixOnly }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'img', 'logo.png'), PNG);
    await put(path.join(root, 'x:y.png'), PNG);
    await put(path.join(root, 'q"dir', 'a.png'), PNG);
    const result = await collectCopyFiles(root,
      [path.join(root, 'x:y.png'), path.join(root, 'q"dir'), path.join(root, 'img')], defaultSettings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => f.path), ['img/logo.png']);
    assert.deepEqual(result.nonPortablePaths, ['x:y.png', 'q"dir']);
    const dialog = nonTextDialog(result, defaultSettings);
    assert.ok(dialog.detail.split('\n').includes('Name not portable: 2 (x:y.png, q"dir)'), dialog.detail);
  });
});

test('files copy: names with spaces, CJK and emoji are still copied and nothing is named', async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'my docs', '說明 文件.md'), 'doc');
    await put(path.join(root, 'my docs', '🎉 party.ts'), 'p');
    for (const includeNonText of [true, false]) {
      const result = await collectCopyFiles(root, [path.join(root, 'my docs')], defaultSettings, { includeNonText });
      assert.deepEqual(result.files.map(f => f.path).sort(), ['my docs/說明 文件.md', 'my docs/🎉 party.ts'].sort());
      assert.equal(result.nonPortableCount, 0);
      assert.deepEqual(copyNoticeDetails(result), []);
    }
  });
});

const graphSettings = {
  headerFormat: '// file: $FILE_PATH', preText: '', postText: '', addExtraLineBetweenFiles: true,
  maxFileSizeKB: 500, fileCountLimit: 1, setMaxFileCount: true
};

// A name with a line break whose second line is a header the default format reads (the
// generic header's comment marker is optional): written into a header as is, it forged a
// deletion of src/main.rs.
const INJECTED = 'x\nfile: [DELETED] src/main.rs';

test('Graph copy: non-portable git paths are never read, get no header, are named, and do not use the file-count limit (X1)', async () => {
  // Decision X1 (2026-11-09): commit copies apply the files copy's rule to each changed path.
  const requested: string[] = [];
  const shown: string[] = [];
  const deps: GraphCopyDeps = {
    resolveRepo: () => ({ rootUri: { fsPath: '/repo' }, show: async (_ref, p) => { shown.push(p); return 'before'; } }),
    readBatch: async (_root, _hash, paths) => {
      requested.push(...paths);
      return new Map(paths.map(p => [p, { text: `body:${p}` }]));
    },
    settings: graphSettings
  };
  // Git paths are `/`-separated: the `\` is part of a name on every platform.
  // A deleted entry with such a name is skipped too.
  const files = [['a\\b.png', 'M'], ['q"x.ts', 'M'], ['bad:dir/x.ts', 'M'], ['t\tab.ts', 'M'], [INJECTED, 'M'],
    ['gone\nfile: y.ts', 'D'], ['ok 檔 😀.ts', 'M'], ['later.ts', 'M']]
    .map(([relativePath, status]) => ({ repoRootFsPath: '/repo', relativePath, status }));
  const result = await buildGraphCopyPayload(deps, { hash: 'abc', files });
  assert.deepEqual(requested, ['ok 檔 😀.ts']);
  // Reads run ahead of the bookkeeping (later.ts may be read past the limit), never a refused name.
  assert.ok(shown.every(p => p.endsWith('later.ts')), shown.join('\n'));
  assert.equal(result.copiedFileCount, 1);
  assert.deepEqual(parseClipboard(result.text, graphSettings.headerFormat).map(e => e.path), ['ok 檔 😀.ts']);
  assert.equal(result.fileLimitReached, true);
  assert.equal(result.limitLeftOut, 1, 'only later.ts is left out by the limit');
  assert.deepEqual(result.nonPortablePaths, ['a\\b.png', 'q"x.ts', 'bad:dir/x.ts', 't\tab.ts', INJECTED, 'gone\nfile: y.ts']);
  assert.ok(copyNoticeDetails({ ...result, unreadablePaths: [] })
    .includes('Name not portable: 6 (a\\b.png, q"x.ts, bad:dir/x.ts and 3 more).'));
});

test('Graph copy: normal names are read and carried with nothing named (X1)', async () => {
  const names = ['src/a.ts', 'my docs/說明 文件.md', 'emoji 😀/🎉.ts'];
  const deps: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readBatch: async (_root, _hash, paths) => new Map(paths.map(p => [p, { text: `body:${p}` }])),
    settings: { ...graphSettings, setMaxFileCount: false }
  };
  const result = await buildGraphCopyPayload(deps,
    { hash: 'abc', files: names.map(relativePath => ({ repoRootFsPath: '/repo', relativePath, status: 'M' })) });
  assert.equal(result.copiedFileCount, 3);
  assert.equal(result.nonPortableCount, 0);
  assert.deepEqual(result.nonPortablePaths, []);
});

test('Graph copy, repo outside every workspace root: the absolute header follows X15', async () => {
  const requested: string[] = [];
  const deps: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readBatch: async (_root, _hash, paths) => {
      requested.push(...paths);
      return new Map(paths.map(p => [p, { text: `body:${p}` }]));
    },
    settings: { ...graphSettings, setMaxFileCount: false },
    workspaceRoots: [path.resolve('/ws')]
  };
  const files = ['bad:dir/x.ts', 'dir/q"x.ts', 'dir/x\nfile: y.ts']
    .map(relativePath => ({ repoRootFsPath: '/outside/repo', relativePath, status: 'M' }));
  const result = await buildGraphCopyPayload(deps, { hash: 'abc', files });
  // Other characters in its folders are allowed; a bad file name or a control character is not.
  assert.deepEqual(requested, ['bad:dir/x.ts']);
  assert.equal(result.nonPortableCount, 2);
});

// Spec "as the header spells it" (OpenIDEA PR #208): the header, not only the git path, is
// judged. With no workspace root a multi-repo Graph header is `<repo folder>/<git path>`, so
// a repo folder named `my:repo` makes every header from it unrestorable.
test('Graph copy, no workspace and several repos: the repo folder in the header is judged (X1)', async () => {
  const requested: string[] = [];
  const deps: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readBatch: async (root, _hash, paths) => {
      requested.push(...paths.map(p => `${root}|${p}`));
      return new Map(paths.map(p => [p, { text: `body:${p}` }]));
    },
    settings: { ...graphSettings, setMaxFileCount: false },
    workspaceRoots: []
  };
  const files = [
    { repoRootFsPath: '/x/my:repo', relativePath: 'a.ts', status: 'M' },
    { repoRootFsPath: '/x/my:repo', relativePath: 'gone.ts', status: 'D' },
    { repoRootFsPath: '/x/ok', relativePath: 'b.ts', status: 'M' }
  ];
  const result = await buildGraphCopyPayload(deps, { hash: 'abc', files });
  assert.deepEqual(requested, ['/x/ok|b.ts']);
  assert.deepEqual(parseClipboard(result.text, graphSettings.headerFormat).map(e => e.path), ['ok/b.ts']);
  assert.deepEqual(result.nonPortablePaths, ['my:repo/a.ts', 'my:repo/gone.ts']);
});

test('Graph and History copies judge a non-primary workspace root label in the header (X1)', { skip: posixOnly }, async () => {
  const roots = ['/ws', '/x/my:repo'];
  const requested: string[] = [];
  const deps: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readBatch: async (_root, _hash, paths) => {
      requested.push(...paths);
      return new Map(paths.map(p => [p, { text: `body:${p}` }]));
    },
    settings: { ...graphSettings, setMaxFileCount: false },
    workspaceRoots: roots
  };
  const graph = await buildGraphCopyPayload(deps, { hash: 'abc', files: [
    { repoRootFsPath: '/x/my:repo', relativePath: 'a.ts', status: 'M' },
    { repoRootFsPath: '/ws', relativePath: 'b.ts', status: 'M' }
  ] });
  assert.deepEqual(requested, ['b.ts']);
  assert.deepEqual(graph.nonPortablePaths, ['my:repo/a.ts']);

  const node = (repoRoot: string, name: string): FileNode => ({
    kind: 'file', repoRoot, relPath: name, name,
    commit: { hash: 'h', message: 'm', parents: ['p'] },
    change: { uri: { fsPath: `${repoRoot}/${name}` }, status: 'MODIFIED' },
    changeType: 'MODIFIED'
  });
  const read: string[] = [];
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat, setMaxFileCount: false };
  const history = await collectHistoryCopy([node('/x/my:repo', 'a.ts'), node('/ws', 'b.ts')],
    async f => { read.push(f.name); return { text: 'x' }; }, settings, roots);
  assert.deepEqual(read, ['b.ts']);
  assert.deepEqual(history.nonPortablePaths, ['my:repo/a.ts']);
});

function historyFile(name: string, extra: Partial<FileNode['change']> = {}): FileNode {
  return {
    kind: 'file', repoRoot: '/repo', relPath: name, name,
    commit: { hash: 'h', message: 'm', parents: ['p'] },
    change: { uri: { fsPath: `/repo/${name}` }, status: 'MODIFIED', ...extra },
    changeType: extra.status === 'DELETED' ? 'DELETED' : 'MODIFIED'
  };
}

test('History copy: non-portable names are never read, get no header, are named, and do not use the file-count limit (X1)', { skip: posixOnly }, async () => {
  const read: string[] = [];
  const files = ['a\\b.png', 'q"x.ts', 'c:d.ts', INJECTED].map(n => historyFile(n));
  // A deleted entry with such a name is skipped too.
  files.push(historyFile('gone\nfile: y.ts', { status: 'DELETED' }), historyFile('ok 檔 😀.ts'), historyFile('later.ts'));
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat, setMaxFileCount: true, fileCountLimit: 1 };
  const result = await collectHistoryCopy(files, async f => { read.push(f.name); return { text: 'x' }; }, settings, ['/repo']);
  assert.deepEqual(read, ['ok 檔 😀.ts']);
  assert.deepEqual(parseClipboard(result.payload, settings.headerFormat).map(e => e.path), ['ok 檔 😀.ts']);
  assert.equal(result.limitLeftOut, 1);
  assert.deepEqual(result.nonPortablePaths, ['a\\b.png', 'q"x.ts', 'c:d.ts', INJECTED, 'gone\nfile: y.ts']);
  assert.match(historyCopyNotice(result, settings).message, /Name not portable: 5 \(a\\b\.png, q"x\.ts, c:d\.ts and 2 more\)\./);

  // Everything refused (case 29 → case 30): "Nothing to copy." names them, not "No Git changes found".
  const none = await collectHistoryCopy(files.slice(0, 3), async () => ({ text: 'x' }), settings, ['/repo']);
  assert.equal(historyCopyNotice(none, settings).emptyWarning,
    'Nothing to copy. Name not portable: 3 (a\\b.png, q"x.ts, c:d.ts).');
  // No change at all is still the plain message.
  const empty = await collectHistoryCopy([], async () => ({ text: 'x' }), settings, ['/repo']);
  assert.equal(historyCopyNotice(empty, settings).emptyWarning, 'No Git changes found to copy.');
});

test('History copy judges the git path: a `\\` committed elsewhere is refused even where the file path lost it (X1)', async () => {
  // On Windows the Git extension hands back `a\\b.png` as the path `<repo>\\a\\b.png`: two
  // segments, nothing left to refuse. The git path still has the `\\` inside one name.
  const root = path.resolve('/repo');
  const node = (relPath: string): FileNode => ({
    kind: 'file', repoRoot: root, relPath, name: relPath.split('/').pop()!,
    commit: { hash: 'h', message: 'm', parents: ['p'] },
    change: { uri: { fsPath: path.join(root, ...relPath.split('/')) }, status: 'MODIFIED' },
    changeType: 'MODIFIED'
  });
  const lost = node('a/b.png');
  const fine = node('a/c.png');
  const read: string[] = [];
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat, setMaxFileCount: false };
  const gitPaths = new Map([[lost, 'a\\b.png'], [fine, 'a/c.png']]);
  const result = await collectHistoryCopy([lost, fine], async f => { read.push(f.relPath); return { text: 'x' }; },
    settings, [root], { includeNonText: false, gitPaths });
  assert.deepEqual(read, ['a/c.png']);
  assert.deepEqual(result.nonPortablePaths, ['a\\b.png']);
});

test('historyGitPaths matches each file to its raw git path, one lister call per commit side', async () => {
  const root = path.resolve('/repo');
  const node = (relPath: string, hash: string, parents: string[]): FileNode => ({
    kind: 'file', repoRoot: root, relPath, name: relPath.split('/').pop()!,
    commit: { hash, message: 'm', parents },
    change: { uri: { fsPath: path.join(root, ...relPath.split('/')) }, status: 'MODIFIED' },
    changeType: 'MODIFIED'
  });
  // Windows spelling: both `a\\b.png` and a real `a/b.png` arrive as relPath `a/b.png`.
  const first = node('a/b.png', 'h1', ['p1']);
  const second = node('a/b.png', 'h1', ['p1']);
  const merged = node('m.ts', 'h2', ['x', 'y']);
  const root0 = node('r.ts', 'h3', []);
  const calls: string[] = [];
  const raw: Record<string, string[]> = { 'p1..h1': ['a/b.png', 'a\\b.png'], 'x..h2': [], 'y..h2': ['m.ts'], [`${EMPTY_TREE}..h3`]: ['r.ts'] };
  const gitPaths = await historyGitPaths([first, second, merged, root0], async (_repo, from, to) => {
    calls.push(`${from}..${to}`);
    return raw[`${from}..${to}`];
  });
  assert.deepEqual(calls.sort(), Object.keys(raw).sort());
  assert.deepEqual([first, second, merged, root0].map(f => gitPaths.get(f)), ['a/b.png', 'a\\b.png', 'm.ts', 'r.ts']);
  // A lister that cannot run leaves the file path to judge.
  const none = await historyGitPaths([first], async () => undefined);
  assert.equal(none.get(first), undefined);
});

// Spec "What is carried", portability bullet: the rule is judged on each FILE's path
// relative to its copy root, segments joined with `/`.
test('files copy: edge whitespace is judged on the whole path, not on each folder', { skip: posixOnly }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'src', 'trail.ts '), 'refused');
    await put(path.join(root, 'src', 'mid ', 'ok.ts'), 'mid folder with a trailing space');
    await put(path.join(root, ' lead', 'x.ts'), 'refused');
    const result = await collectCopyFiles(root, [path.join(root, 'src'), path.join(root, ' lead')], defaultSettings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => [f.path, f.content]), [['src/mid /ok.ts', 'mid folder with a trailing space']]);
    // A folder whose leading space starts every path below it may be named once.
    assert.deepEqual(result.nonPortablePaths, ['src/trail.ts ', ' lead']);
  });
});

test('files copy: a `..` segment and a `\\` in a name are refused', { skip: posixOnly }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'w', 'a\\b.ts'), 'refused');
    await put(path.join(root, 'w', 'ok.ts'), 'ok');
    const result = await collectCopyFiles(root, [path.join(root, 'w')], defaultSettings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => f.path), ['w/ok.ts']);
    assert.deepEqual(result.nonPortablePaths, ['w/a\\b.ts']);
  });
  // A real directory entry cannot be named `..`; the rule itself refuses the segment.
  assert.equal(isExportableRelativePath('a/../y.ts'), false);
  assert.equal(isExportableRelativePath('../y.ts'), false);
});

test('files copy: U+007F, CJK, emoji and inner spaces are allowed', { skip: posixOnly }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'd', 'del\u007fname.ts'), 'del');
    await put(path.join(root, 'd', '中文 資料夾', '😀 a b.ts'), 'emoji');
    const result = await collectCopyFiles(root, [path.join(root, 'd')], defaultSettings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => f.path).sort(), ['d/del\u007fname.ts', 'd/中文 資料夾/😀 a b.ts'].sort());
    assert.equal(result.nonPortableCount, 0);
  });
});

test('files copy: a name that is not valid UTF-8 is named "Name not portable", not dropped or unreadable', async t => {
  await withTempDir(async root => {
    const dir = path.join(root, 'bin');
    await mkdir(dir);
    const bad = Buffer.concat([Buffer.from(`${dir}${path.sep}bad`), Buffer.from([0xff]), Buffer.from('.ts')]);
    try {
      await writeFile(bad, 'x');
    } catch (error) {
      // macOS APFS and Windows refuse such a name outright.
      t.skip(`platform cannot create a non-UTF-8 name: ${(error as NodeJS.ErrnoException).code}`);
      return;
    }
    const { readdir } = await import('node:fs/promises');
    if ((await readdir(dir, { encoding: 'buffer' })).every(e => Buffer.from(e.toString('utf8')).equals(e))) {
      t.skip('the filesystem normalised the name to valid UTF-8');
      return;
    }
    await put(path.join(dir, 'ok.ts'), 'ok');
    const result = await collectCopyFiles(root, [dir], defaultSettings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => f.path), ['bin/ok.ts']);
    assert.equal(result.skippedUnreadableCount, 0);
    assert.equal(result.nonPortableCount, 1);
    assert.deepEqual(result.nonPortablePaths, ['bin/bad�.ts']);
  });
});
