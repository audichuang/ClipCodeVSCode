import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCopyFiles } from '../src/copy.js';
import { buildGraphCopyPayload, type GraphCopyDeps } from '../src/graphCopy.js';
import { collectHistoryCopy } from '../src/historyCopy.js';
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
  // Under no root: the clipboard path is absolute, every folder after `/` is judged.
  assert.equal(nonPortableName(['/ws'], '/elsewhere/dir/a.ts'), undefined);
  assert.equal(nonPortableName(['/ws'], '/else:where/a.ts'), '/else:where/a.ts');
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
    await put(path.join(root, 'src', 'ok name 檔案 😀.ts'), 'ok');

    // A limit of 1: the five refused entries come first in the walk and must not use it up.
    const settings = { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 1 };
    const result = await collectCopyFiles(root, [path.join(root, 'src')], settings, { includeNonText: true });
    assert.deepEqual(result.files.map(f => [f.path, f.content]), [['src/ok name 檔案 😀.ts', 'ok']]);
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

test('Graph copy does not apply the files copy\'s "Name not portable" rule', async () => {
  // Spec "What is carried": OpenIDEA's commit copies do not report this category.
  const requested: string[] = [];
  const deps: GraphCopyDeps = {
    resolveRepo: () => undefined,
    readBatch: async (_root, _hash, paths) => {
      requested.push(...paths);
      return new Map(paths.map(p => [p, { text: `body:${p}` }]));
    },
    settings: { ...graphSettings, setMaxFileCount: false }
  };
  const names = ['a\\b.ts', 'q"x.ts', 'bad:dir/x.ts', 't\tab.ts', 'ok 檔 😀.ts'];
  const files = names.map(relativePath => ({ repoRootFsPath: '/repo', relativePath, status: 'M' }));
  const result = await buildGraphCopyPayload(deps, { hash: 'abc', files });
  assert.deepEqual(requested, names);
  assert.equal(result.copiedFileCount, 5);
  assert.ok(!('nonPortableCount' in result));
});

function historyFile(name: string): FileNode {
  return {
    kind: 'file', repoRoot: '/repo', relPath: name, name,
    commit: { hash: 'h', message: 'm', parents: ['p'] },
    change: { uri: { fsPath: `/repo/${name}` }, status: 'MODIFIED' },
    changeType: 'MODIFIED'
  };
}

test('History copy does not apply the files copy\'s "Name not portable" rule', { skip: posixOnly }, async () => {
  const read: string[] = [];
  const names = ['q"x.ts', 'c:d.ts', 'ok 檔 😀.ts'];
  const settings = { ...defaultSettings, headerFormat: graphSettings.headerFormat, setMaxFileCount: false };
  const result = await collectHistoryCopy(names.map(historyFile), async f => { read.push(f.name); return { text: 'x' }; }, settings, ['/repo']);
  assert.deepEqual(read, names);
  // The clipboard path falls back to the absolute path, as before (toClipboardPathFromRoots).
  assert.deepEqual(result.files.map(f => f.path), ['/repo/q"x.ts', '/repo/c:d.ts', 'ok 檔 😀.ts']);
  assert.ok(!('nonPortableCount' in result));
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
