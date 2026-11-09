import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseClipboard } from '../src/clipboardFormat.js';
import { collectCopyFiles, LEFT_OUT_CAP, type CopyResult } from '../src/copy.js';
import { copyNoticeDetails, nonTextDialog, shortenPath } from '../src/nonTextDialog.js';
import { parseBody, placeholderLine, sha256Hex } from '../src/nonText.js';
import { formatSize } from '../src/restoreSummary.js';
import { defaultSettings, normalizeSettings, type ClipCodeSettings } from '../src/settings.js';

// Files-mode copy of non-text files (spec non-text-files.md, cases 7, 11, 15, 16, 19).

const INCLUDE = { includeNonText: true };
const EXCLUDE = { includeNonText: false };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// Windows ignores POSIX modes, so chmod 000 does not make anything unreadable there.
const noModeDenial = process.platform === 'win32' ? 'Windows ignores POSIX modes' : undefined;

/** A tiny "PNG": the signature has a NUL-free start, the IHDR length field carries NULs. */
function png(seed: number, size = 64): Buffer {
  const bytes = Buffer.alloc(size, seed & 0xff);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(bytes);
  return bytes;
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipcode-nontext-copy-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function nonTextPathsInPayload(result: CopyResult, settings: ClipCodeSettings): string[] {
  return parseClipboard(result.payload, settings.headerFormat)
    .filter(entry => parseBody(entry.content) !== undefined)
    .map(entry => entry.path);
}

test('settings: maxNonTextFileSizeKB defaults to 2048 and must be a positive number', () => {
  assert.equal(defaultSettings.maxNonTextFileSizeKB, 2048);
  assert.equal(normalizeSettings({ maxNonTextFileSizeKB: 10 }).maxNonTextFileSizeKB, 10);
  assert.equal(normalizeSettings({ maxNonTextFileSizeKB: 0 }).maxNonTextFileSizeKB, 2048);
  assert.equal(normalizeSettings({ maxNonTextFileSizeKB: -1 }).maxNonTextFileSizeKB, 2048);
});

test('case 7: each file is held to its own limit; over both limits it is not read', async () => {
  await withTempDir(async root => {
    const big = 700 * 1024;
    await put(path.join(root, 'a-data.json'), `"${'x'.repeat(big - 2)}"`);
    const image = png(1, big);
    await put(path.join(root, 'b-image.png'), image);
    await put(path.join(root, 'c-huge.png'), png(2, 3 * 1024 * 1024));
    const settings = defaultSettings; // 500 KB text, 2048 KB non-text

    const result = await collectCopyFiles(root, [root], settings, INCLUDE);

    assert.deepEqual(result.files.map(f => [f.path, f.skippedReason]), [
      ['a-data.json', `size exceeds limit (${big} bytes)`],
      ['b-image.png', undefined],
      ['c-huge.png', `size exceeds limit (${3 * 1024 * 1024} bytes)`]
    ]);
    assert.deepEqual(Buffer.from(result.files[1].nonText!), image);
    assert.ok(result.payload.includes(`// file: b-image.png\n${placeholderLine(big, sha256Hex(image))}\n`));
    assert.equal(result.copiedFileCount, 1);
    assert.equal(result.skippedFileSizeCount, 2);
    assert.equal(result.unreadOverLimitCount, 1);
    assert.equal(result.nonTextOverLimitCount, 0);
    assert.deepEqual(result.nonTextFiles, [{ path: 'b-image.png', size: big }]);
    assert.equal(result.nonTextTotalBytes, big);
    assert.equal(result.estimatedBytes, Buffer.byteLength(result.payload, 'utf8'));

    // A non-text file read (under the text limit) but over its own, lower limit.
    const tight = { ...settings, maxNonTextFileSizeKB: 100 };
    const small = png(3, 200 * 1024);
    await rm(path.join(root, 'b-image.png'));
    await rm(path.join(root, 'c-huge.png'));
    await put(path.join(root, 'd-small.png'), small);
    const over = await collectCopyFiles(root, [root], tight, INCLUDE);
    assert.deepEqual(over.files.map(f => [f.path, f.skippedReason]), [
      ['a-data.json', `size exceeds limit (${big} bytes)`],
      ['d-small.png', `size exceeds limit (${small.length} bytes)`]
    ]);
    assert.equal(over.nonTextOverLimitCount, 1);
    assert.equal(over.unreadOverLimitCount, 1, 'the 700 KB json is now over both limits');
    assert.deepEqual(over.nonTextFiles, []);
  });
});

test('case 11: Exclude produces the payload from before non-text support, byte for byte', async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await put(path.join(root, 'src', 'b-logo.png'), png(4));
    await put(path.join(root, 'src', 'c-big5.csv'), Buffer.from([0xa4, 0xe9, 0xa5, 0xbb, 0x0a]));
    // Over the text limit, under the non-text one: the old rule never read it and wrote a
    // size placeholder, so Exclude must too (Include reads and carries it).
    const wide = png(5, 3000);
    await put(path.join(root, 'src', 'd-wide.png'), wide);
    await put(path.join(root, 'src', 'e.md'), '# title');
    const settings = { ...defaultSettings, maxFileSizeKB: 2 };

    const excluded = await collectCopyFiles(root, [path.join(root, 'src')], settings, EXCLUDE);
    // Literal payload of the pre-change collectCopyFiles (cbde05b) for this folder.
    assert.equal(excluded.payload, [
      `// clipcode-root: ${path.basename(root)}`,
      '',
      '// file: src/a.ts',
      'export const a = 1;',
      '',
      '',
      '// file: src/d-wide.png',
      '// File skipped: size exceeds limit (3000 bytes)',
      '',
      '// file: src/e.md',
      '# title',
      '',
      ''
    ].join('\n'));
    assert.equal(excluded.excludedNonTextCount, 2);
    assert.deepEqual(excluded.nonTextFiles, []);

    const included = await collectCopyFiles(root, [path.join(root, 'src')], settings, INCLUDE);
    assert.deepEqual(nonTextPathsInPayload(included, settings), ['src/b-logo.png', 'src/c-big5.csv', 'src/d-wide.png']);
    assert.deepEqual(included.nonTextFiles.map(f => f.size), [64, 5, 3000]);
  });
});

test('case 15: dialog count, list and estimate are those of the Include payload under the file-count limit', async () => {
  await withTempDir(async root => {
    for (let i = 0; i < 40; i++) await put(path.join(root, `img-${String(i).padStart(2, '0')}.png`), png(i));
    const settings = { ...defaultSettings, fileCountLimit: 30 };

    const result = await collectCopyFiles(root, [root], settings, INCLUDE);
    const carried = nonTextPathsInPayload(result, settings);
    assert.equal(carried.length, 30);
    assert.deepEqual(result.nonTextFiles.map(f => f.path), carried);
    assert.equal(result.limitLeftOut, 10);
    assert.equal(result.copiedFileCount, 30);

    const dialog = nonTextDialog(result, settings);
    const lines = dialog.detail.split('\n');
    assert.equal(lines[0], `Non-text files: 30 (${formatSize(30 * 64)})`);
    assert.equal(lines[1], `Estimated payload with them: ${formatSize(Buffer.byteLength(result.payload, 'utf8'))}`);
    assert.deepEqual(lines.slice(2, 12).map(line => line.split('  ')[0]), carried.slice(0, 10));
    assert.equal(lines[12], 'and 20 more');
    assert.ok(lines.includes('Left out by the file-count limit: 10'));
    assert.deepEqual(dialog.buttons, ['Include', 'Exclude']);
    assert.ok(copyNoticeDetails(result).includes('Non-text files copied as Base64: 30.'));
    assert.ok(copyNoticeDetails(result).includes('Left out by the file-count limit: 10.'));
  });
});

test('case 15: size placeholders in the selection do not shift the dialog numbers off the Include payload', async () => {
  await withTempDir(async root => {
    // Over both limits, ordered before the images: placeholders, never read, and they do not
    // consume the file-count limit (as before). One more after the images is cut by the limit.
    for (const name of ['a-big-0.bin', 'a-big-1.bin', 'a-big-2.bin', 'z-big.bin']) await put(path.join(root, name), png(9, 3000));
    for (let i = 0; i < 40; i++) await put(path.join(root, `img-${String(i).padStart(2, '0')}.png`), png(i));
    const settings = { ...defaultSettings, fileCountLimit: 30, maxFileSizeKB: 1, maxNonTextFileSizeKB: 2 };

    const result = await collectCopyFiles(root, [root], settings, INCLUDE);
    const entries = parseClipboard(result.payload, settings.headerFormat);
    assert.equal(entries.length, 33);
    assert.equal(nonTextPathsInPayload(result, settings).length, 30);
    assert.equal(result.nonTextFiles.length, 30);
    assert.equal(result.unreadOverLimitCount, 3);
    assert.equal(result.limitLeftOut, 11, '10 images and z-big.bin');

    const lines = nonTextDialog(result, settings).detail.split('\n');
    assert.ok(lines.includes('Over both size limits (not read, copied as size placeholders): 3'));
    assert.ok(lines.includes('Left out by the file-count limit: 11'));
    assert.equal(lines[0], `Non-text files: 30 (${formatSize(30 * 64)})`);
  });
});

test('case 15: text files that fill the limit first leave Include with no non-text file (no dialog)', async () => {
  await withTempDir(async root => {
    for (let i = 0; i < 30; i++) await put(path.join(root, `a-${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};`);
    for (let i = 0; i < 5; i++) await put(path.join(root, `b-${i}.png`), png(i));
    const settings = { ...defaultSettings, fileCountLimit: 30 };

    const include = await collectCopyFiles(root, [root], settings, INCLUDE);
    const exclude = await collectCopyFiles(root, [root], settings, EXCLUDE);
    assert.deepEqual(include.nonTextFiles, [], 'the extension asks only when this is non-empty');
    assert.equal(include.limitLeftOut, 5);
    assert.equal(include.payload, exclude.payload);
    assert.ok(copyNoticeDetails(include).includes('Left out by the file-count limit: 5.'));
  });
});

test('file-count limit: the left-out count is capped, the walk stops there and says N+', async () => {
  await withTempDir(async root => {
    for (let i = 0; i < 3; i++) await put(path.join(root, `a-${i}.png`), png(i));
    for (let i = 0; i < 20; i++) await put(path.join(root, `b-${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};`);
    const settings = { ...defaultSettings, fileCountLimit: 3 };

    for (const options of [INCLUDE, EXCLUDE]) {
      const full = await collectCopyFiles(root, [root], settings, options);
      // Include: the 3 images fill the limit; Exclude leaves them out, so 3 .ts files do.
      assert.equal(full.limitLeftOut, options.includeNonText ? 20 : 17);
      assert.equal(full.limitLeftOutCapped, false);

      // Cap 5: the walk stops at the 6th left-out candidate instead of walking the whole tree.
      const capped = await collectCopyFiles(root, [root], settings, { ...options, leftOutCap: 5 });
      assert.equal(capped.limitLeftOut, 5);
      assert.equal(capped.limitLeftOutCapped, true);
      assert.equal(capped.payload, full.payload, 'what was copied does not depend on the cap');
      assert.ok(copyNoticeDetails(capped).includes('Left out by the file-count limit: 5+.'));
      if (options.includeNonText) {
        assert.ok(nonTextDialog(capped, settings).detail.split('\n').includes('Left out by the file-count limit: 5+'));
      }

      // Exactly at the cap is not "more than": no plus sign.
      const exact = await collectCopyFiles(root, [root], settings, { ...options, leftOutCap: full.limitLeftOut });
      assert.equal(exact.limitLeftOut, full.limitLeftOut);
      assert.equal(exact.limitLeftOutCapped, false);
    }
    assert.equal(LEFT_OUT_CAP, 1000);
  });
});

test('case 16: unreadable files dropped during folder expansion are named', { skip: noModeDenial || (isRoot && 'root reads mode 000 files') }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'src', 'ok.ts'), 'ok');
    await put(path.join(root, 'src', 'locked.ts'), 'secret');
    await put(path.join(root, 'src', 'shut', 'inner.ts'), 'inner');
    await symlink(path.join(root, 'nowhere'), path.join(root, 'src', 'dangling.ts'));
    await chmod(path.join(root, 'src', 'locked.ts'), 0o000);
    await chmod(path.join(root, 'src', 'shut'), 0o000);
    try {
      const result = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings, INCLUDE);
      assert.deepEqual(result.files.map(f => f.path), ['src/ok.ts']);
      assert.equal(result.skippedUnreadableCount, 3);
      assert.deepEqual([...result.unreadablePaths].sort(), ['src/dangling.ts', 'src/locked.ts', 'src/shut']);
      const notice = copyNoticeDetails(result).join(' ');
      assert.match(notice, /^Unreadable: 3 \(/);
      for (const name of ['src/dangling.ts', 'src/locked.ts', 'src/shut']) assert.ok(notice.includes(name), notice);
      assert.doesNotMatch(notice, /binary|non-UTF-8|not UTF-8/i);
    } finally {
      await chmod(path.join(root, 'src', 'locked.ts'), 0o600);
      await chmod(path.join(root, 'src', 'shut'), 0o700);
    }
  });
});

test('case 19: a selected unreadable folder is named, the selected file is copied', { skip: noModeDenial || (isRoot && 'root lists mode 000 folders') }, async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'shut', 'inner.ts'), 'inner');
    await put(path.join(root, 'ok.ts'), 'ok');
    await chmod(path.join(root, 'shut'), 0o000);
    try {
      const result = await collectCopyFiles(root, [path.join(root, 'shut'), path.join(root, 'ok.ts')], defaultSettings, INCLUDE);
      assert.deepEqual(result.files.map(f => [f.path, f.content]), [['ok.ts', 'ok']]);
      assert.deepEqual(result.unreadablePaths, ['shut']);
      assert.deepEqual(copyNoticeDetails(result), ['Unreadable: 1 (shut).']);
    } finally {
      await chmod(path.join(root, 'shut'), 0o700);
    }
  });
});

test('case 22: a symlinked folder is not followed and is named in the dialog and the notice', async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'real', 'inner.png'), png(7));
    await put(path.join(root, 'assets', 'logo.png'), png(8));
    await symlink(path.join(root, 'real'), path.join(root, 'assets', 'linked'), 'dir');
    await symlink(path.join(root, 'real'), path.join(root, 'direct'), 'dir');

    const result = await collectCopyFiles(root, [path.join(root, 'direct'), path.join(root, 'assets')], defaultSettings, INCLUDE);
    assert.deepEqual(result.files.map(f => f.path), ['assets/logo.png']);
    assert.equal(result.symlinkedFolderCount, 2);
    assert.deepEqual(result.symlinkedFolderPaths, ['direct', 'assets/linked']);

    const dialog = nonTextDialog(result, defaultSettings);
    assert.ok(dialog.detail.split('\n').includes('Symlinked folder: 2 (direct, assets/linked)'), dialog.detail);
    assert.ok(copyNoticeDetails(result).includes('Symlinked folder: 2 (direct, assets/linked).'));
    assert.equal(result.skippedUnreadableCount, 0);
  });
});

test('symlinked folder notice names three and says how many more', () => {
  const notice = copyNoticeDetails({
    nonTextFiles: [], excludedNonTextCount: 0, limitLeftOut: 0, skippedUnreadableCount: 0, unreadablePaths: [],
    symlinkedFolderCount: 5, symlinkedFolderPaths: ['a', 'b', 'c', 'd', 'e']
  });
  assert.deepEqual(notice, ['Symlinked folder: 5 (a, b, c and 2 more).']);
});

test('a symlink to a file is followed and carries the target bytes under the link path', async () => {
  await withTempDir(async root => {
    const bytes = png(9);
    await put(path.join(root, 'store', 'pic.png'), bytes);
    await put(path.join(root, 'store', 'note.ts'), 'note');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await symlink(path.join(root, 'store', 'pic.png'), path.join(root, 'src', 'pic.png'), 'file');
    await symlink(path.join(root, 'store', 'note.ts'), path.join(root, 'src', 'note.ts'), 'file');

    // Expanded from a selected folder, and selected directly.
    for (const input of [path.join(root, 'src'), path.join(root, 'src', 'pic.png')]) {
      const result = await collectCopyFiles(root, [input], defaultSettings, INCLUDE);
      const pic = result.files.find(f => f.path === 'src/pic.png');
      assert.ok(pic?.nonText, `src/pic.png carried from ${input}`);
      assert.deepEqual(Buffer.from(pic.nonText), bytes);
      assert.equal(result.symlinkedFolderCount, 0);
    }
    const expanded = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings, INCLUDE);
    assert.equal(expanded.files.find(f => f.path === 'src/note.ts')?.content, 'note');
  });
});

test('case 25: an unescapable headerFormat offers only Exclude and says why', async () => {
  await withTempDir(async root => {
    await put(path.join(root, 'logo.png'), png(1));
    const settings = { ...defaultSettings, headerFormat: '$FILE_PATH' };
    const result = await collectCopyFiles(root, [root], settings, INCLUDE);
    const dialog = nonTextDialog(result, settings);
    assert.deepEqual(dialog.buttons, ['Exclude']);
    assert.ok(dialog.detail.includes(
      'Include is unavailable: the header format "$FILE_PATH" cannot be escaped, so Base64 lines would read as file headers.'));
  });
});

test('dialog paths: the folder part shrinks first and the file name with its extension stays whole', () => {
  const folder = 'd11long/' + 'a-really-long-folder-name/'.repeat(6);
  const shortened = shortenPath(`${folder}name-alpha.png`, 70);
  assert.ok(shortened.endsWith('…/name-alpha.png'), shortened);
  assert.ok(shortened.startsWith('d11long/a-really-long'), shortened);
  assert.equal(Array.from(shortened).length, 70);

  // Three 58–60 character names sharing a prefix under a 150-character folder: still distinct.
  const deep = 'f'.repeat(150);
  const names = ['shared-prefix-for-every-one-of-these-names-variant-alpha.png',
    'shared-prefix-for-every-one-of-these-names-variant-beta.png',
    'shared-prefix-for-every-one-of-these-names-variant-gamma1.png'];
  const shown = names.map(name => shortenPath(`${deep}/${name}`, 70));
  assert.equal(new Set(shown).size, 3);
  for (const [i, line] of shown.entries()) {
    assert.ok(Array.from(line).length <= 70, line);
    assert.ok(line.endsWith(names[i].slice(-10)), line);
  }

  // A cut never splits a character: an astral or combined character stays whole.
  const emoji = shortenPath(`${'😀'.repeat(80)}.png`, 20);
  assert.ok(emoji.endsWith('.png'));
  assert.ok(!/[\uD800-\uDBFF]…|…[\uDC00-\uDFFF]/.test(emoji), emoji);
  const combined = shortenPath(`${'é'.repeat(80)}.png`, 20);
  assert.ok(!combined.includes('…́'), combined);
  assert.ok(!/e…/.test(combined), combined);
  assert.equal(shortenPath('short/name.png', 70), 'short/name.png');
});
