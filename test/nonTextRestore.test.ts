import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPayload, parseClipboard, type PayloadFile } from '../src/clipboardFormat.js';
import { writeBytesFile, writeTextFile } from '../src/fileSystem.js';
import { placeholderLine, sha256Hex } from '../src/nonText.js';
import {
  executeRestorePlan,
  ioErrorText,
  isPlaceholderBody,
  markTargetCollisions,
  planRestore
} from '../src/restore.js';
import { confirmationText, existingTargets, resultNotice } from '../src/restoreSummary.js';

// Spec non-text-files.md, "Pasting" and required test cases 1-4, 6, 8, 9, 12, 18, 20, 23, 27.

const H = '// file: $FILE_PATH';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.alloc(100, 0),
  Buffer.from('IHDR')
]);
const BIG5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0xb4, 0xfa, 0xb8, 0xd5, 0x0a]);

function payload(files: PayloadFile[], headerFormat = H): string {
  return buildPayload({ headerFormat, preText: '', postText: '', addExtraLineBetweenFiles: true, files });
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'clipcode-nontext-restore-')));
  try {
    await run(root);
  } finally {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function paste(root: string, text: string, headerFormat = H, overwrite = true) {
  const plan = await markTargetCollisions(await planRestore(root, parseClipboard(text, headerFormat)));
  const result = await executeRestorePlan(plan, { overwriteExisting: overwrite, skipExisting: !overwrite });
  return { plan, result };
}

test('cases 1-3: PNG with NULs, Big5 text and a 1-byte 0x00 file round-trip byte for byte; an empty file stays text', async () => {
  await withRoot(async root => {
    const text = payload([
      { path: 'img/logo.png', nonText: PNG },
      { path: 'legacy/big5.txt', nonText: BIG5 },
      { path: 'nul.bin', nonText: new Uint8Array([0]) },
      { path: 'empty.txt', content: '' }
    ]);
    const { plan, result } = await paste(root, text);
    assert.deepEqual(plan.skippedOperations, []);
    assert.deepEqual(plan.createOperations.map(op => [op.relativePath, op.content, op.nonText?.bytes.length]), [
      ['img/logo.png', '', PNG.length],
      ['legacy/big5.txt', '', BIG5.length],
      ['nul.bin', '', 1],
      ['empty.txt', '', undefined]
    ]);
    assert.equal(result.createdCount, 4);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(await readFile(path.join(root, 'img/logo.png')), PNG);
    assert.deepEqual(await readFile(path.join(root, 'legacy/big5.txt')), BIG5);
    assert.deepEqual(await readFile(path.join(root, 'nul.bin')), Buffer.from([0]));
    assert.deepEqual(await readFile(path.join(root, 'empty.txt')), Buffer.alloc(0));
  });
});

test('case 4: a CRLF payload (Windows clipboard) still decodes', async () => {
  await withRoot(async root => {
    const text = payload([{ path: 'img/logo.png', nonText: PNG }]).replace(/\n/g, '\r\n');
    const { result } = await paste(root, text);
    assert.equal(result.createdCount, 1);
    assert.deepEqual(await readFile(path.join(root, 'img/logo.png')), PNG);
  });
});

test('case 6: truncated Base64 and a wrong SHA-256 each skip only that file and report it', async () => {
  await withRoot(async root => {
    const good = payload([{ path: 'img/logo.png', nonText: PNG }]);
    const lines = good.split('\n');
    const placeholderAt = lines.findIndex(line => line.startsWith('// File skipped: non-text file'));
    const truncated = [...lines];
    truncated[placeholderAt + 1] = truncated[placeholderAt + 1].slice(0, -4);
    const badSha = [...lines];
    badSha[placeholderAt] = placeholderLine(PNG.length, '0'.repeat(64));
    const text = [
      truncated.join('\n').replace('img/logo.png', 'trunc.png'),
      badSha.join('\n').replace('img/logo.png', 'sha.png'),
      payload([{ path: 'src/ok.ts', content: 'ok' }])
    ].join('\n');
    const { plan, result } = await paste(root, text);
    assert.deepEqual(plan.skippedOperations.map(op => [op.rawPath, op.reason]), [
      ['trunc.png', 'CORRUPT_NON_TEXT'],
      ['sha.png', 'CORRUPT_NON_TEXT']
    ]);
    assert.equal(result.createdCount, 1);
    assert.equal(await readFile(path.join(root, 'src/ok.ts'), 'utf8'), 'ok');
    await assert.rejects(lstat(path.join(root, 'trunc.png')), { code: 'ENOENT' });
  });
});

test('case 8: a reader without this feature skips the entry — its first line trips the old placeholder guard', () => {
  for (const headerFormat of [H, '// $FILE_PATH']) {
    const [entry] = parseClipboard(payload([{ path: 'img/logo.png', nonText: PNG }], headerFormat), headerFormat);
    // The previous release planned every non-DELETED entry through exactly this guard first.
    assert.equal(isPlaceholderBody(entry.content), true, headerFormat);
  }
});

test('case 9: an identical target is unchanged without overwrite permission; a different one follows the overwrite option', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'same.png'), PNG);
    await writeFile(path.join(root, 'diff.png'), Buffer.from('old bytes'));
    const text = payload([{ path: 'same.png', nonText: PNG }, { path: 'diff.png', nonText: PNG }]);

    const plan = await planRestore(root, parseClipboard(text, H));
    assert.deepEqual(plan.createOperations.map(op => [op.relativePath, op.existed, op.nonText?.identical]), [
      ['same.png', true, true],
      ['diff.png', true, false]
    ]);

    const kept = await executeRestorePlan(plan, { overwriteExisting: false, skipExisting: true });
    assert.deepEqual([kept.unchangedCount, kept.skippedExistingCount, kept.overwrittenCount], [1, 1, 0]);
    assert.deepEqual(await readFile(path.join(root, 'diff.png')), Buffer.from('old bytes'));

    const replaced = await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.deepEqual([replaced.unchangedCount, replaced.overwrittenCount], [1, 1]);
    assert.deepEqual(await readFile(path.join(root, 'diff.png')), PNG);
  });
});

test('a non-text entry is written over a non-UTF-8 target: the non-UTF-8 guard is for text only', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'legacy.txt'), Buffer.from([0xa4, 0xe9]));
    const { plan, result } = await paste(root, payload([{ path: 'legacy.txt', nonText: BIG5 }]));
    assert.deepEqual(plan.skippedOperations, []);
    assert.equal(result.overwrittenCount, 1);
    assert.deepEqual(await readFile(path.join(root, 'legacy.txt')), BIG5);
  });
});

test('case 12: placeholder-shaped text round-trips as text next to a real non-text file, under both header formats', async () => {
  const fake = `${placeholderLine(3, sha256Hex(Buffer.from('abc')))}\nYWJj`;
  const escaped = `//clipcode-esc: ${placeholderLine(3, sha256Hex(Buffer.from('abc')))}\nline two`;
  for (const headerFormat of [H, '// $FILE_PATH']) {
    await withRoot(async root => {
      const text = payload([
        { path: 'a.bin', nonText: PNG },
        { path: 't1.txt', content: fake },
        { path: 't2.txt', content: escaped }
      ], headerFormat);
      const { plan, result } = await paste(root, text, headerFormat);
      assert.deepEqual(plan.skippedOperations, [], headerFormat);
      assert.equal(result.createdCount, 3, headerFormat);
      assert.deepEqual(await readFile(path.join(root, 'a.bin')), PNG, headerFormat);
      assert.equal(await readFile(path.join(root, 't1.txt'), 'utf8'), fake, headerFormat);
      assert.equal(await readFile(path.join(root, 't2.txt'), 'utf8'), escaped, headerFormat);
    });
  }
});

test('case 18: missing padding, non-zero trailing bits and characters outside the alphabet make the entry corrupt', async () => {
  const one = Buffer.from([0]);
  const header = placeholderLine(1, sha256Hex(one));
  for (const base64 of ['AA', 'AB==', 'A-==', 'A*==']) {
    const plan = await planRestore(os.tmpdir(), parseClipboard(`// file: x.bin\n${header}\n${base64}\n`, H));
    assert.deepEqual(plan.skippedOperations.map(op => op.reason), ['CORRUPT_NON_TEXT'], base64);
    assert.equal(plan.createOperations.length, 0, base64);
  }
  const plan = await planRestore(os.tmpdir(), parseClipboard(`// file: x.bin\n${header}\n A\tA=\r\n=\n`, H));
  assert.deepEqual(plan.skippedOperations, [], 'ASCII whitespace inside the Base64 is ignored');
  assert.deepEqual(plan.createOperations[0].nonText?.bytes, new Uint8Array(one));
});

test('case 20: a directory at a target path skips only that row; the others restore', async () => {
  await withRoot(async root => {
    await mkdir(path.join(root, 'taken.png'));
    const text = payload([{ path: 'taken.png', nonText: PNG }, { path: 'ok.png', nonText: PNG }, { path: 'taken2.txt', content: 'x' }]);
    await mkdir(path.join(root, 'taken2.txt'));
    const { plan, result } = await paste(root, text);
    assert.deepEqual(plan.skippedOperations.map(op => [op.rawPath, op.relativePath, op.reason]), [
      ['taken.png', 'taken.png', 'TARGET_NOT_FILE'],
      ['taken2.txt', 'taken2.txt', 'TARGET_NOT_FILE']
    ]);
    assert.deepEqual(plan.createOperations.map(op => op.relativePath), ['ok.png']);
    assert.equal(result.createdCount, 1);
    assert.deepEqual(result.errors, []);
  });
});

test('case 27: an existing file where a parent folder must be skips only that row, with no raw OS error', async () => {
  await withRoot(async root => {
    await mkdir(path.join(root, 'd3'));
    await writeFile(path.join(root, 'd3', 'a'), 'a file');
    const text = payload([{ path: 'd3/a/deep.png', nonText: PNG }, { path: 'd3/a/x/text.txt', content: 't' }, { path: 'd3/ok.txt', content: 'ok' }]);
    const { plan, result } = await paste(root, text);
    assert.deepEqual(plan.skippedOperations.map(op => [op.relativePath, op.reason]), [
      ['d3/a/deep.png', 'PARENT_NOT_FOLDER'],
      ['d3/a/x/text.txt', 'PARENT_NOT_FOLDER']
    ]);
    assert.equal(result.createdCount, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(path.join(root, 'd3/ok.txt'), 'utf8'), 'ok');
  });
});

test('case 23: IMG.png and img.png on a case-insensitive volume are both skipped; the other entries restore', async t => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'Probe'), '');
    const insensitive = await lstat(path.join(root, 'pROBE')).then(() => true, () => false);
    await rm(path.join(root, 'Probe'));
    if (!insensitive) {
      t.skip('this temp volume is case-sensitive');
      return;
    }
    const text = payload([
      { path: 'IMG.png', nonText: PNG },
      { path: 'img.png', nonText: BIG5 },
      { path: 'other.png', nonText: PNG },
      { path: 'Src/A.ts', content: 'upper' },
      { path: 'src/a.ts', content: 'lower' }
    ]);
    const { plan, result } = await paste(root, text);
    assert.deepEqual(plan.skippedOperations.map(op => [op.relativePath, op.reason]), [
      ['IMG.png', 'TARGET_COLLISION'],
      ['img.png', 'TARGET_COLLISION'],
      ['Src/A.ts', 'TARGET_COLLISION'],
      ['src/a.ts', 'TARGET_COLLISION']
    ]);
    assert.deepEqual(plan.createOperations.map(op => op.relativePath), ['other.png']);
    assert.equal(result.createdCount, 1);
    await assert.rejects(lstat(path.join(root, 'img.png')), { code: 'ENOENT' });
  });
});

test('the same spelling twice is not a collision: it stays planned twice, in order', async () => {
  await withRoot(async root => {
    const plan = await markTargetCollisions(await planRestore(root, parseClipboard(
      payload([{ path: 'dup.ts', content: 'first' }, { path: 'dup.ts', content: 'second' }]), H)));
    assert.deepEqual(plan.createOperations.map(op => op.content), ['first', 'second']);
    assert.deepEqual(plan.skippedOperations, []);
  });
});

test('a failed write or delete is reported in user text, never the raw OS message', async t => {
  assert.equal(ioErrorText(Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })), 'Folder is not writable');
  assert.equal(ioErrorText(Object.assign(new Error('x'), { code: 'ENOSPC' })), 'The disk is full');
  assert.equal(ioErrorText(new Error('anything else')), 'Could not apply the change');
  if (process.getuid?.() === 0) {
    t.diagnostic('running as root: chmod does not deny writes, the live part is skipped');
    return;
  }
  await withRoot(async root => {
    await mkdir(path.join(root, 'locked'));
    await chmod(path.join(root, 'locked'), 0o555);
    try {
      const { result } = await paste(root, payload([{ path: 'locked/new.png', nonText: PNG }, { path: 'locked/new.txt', content: 'x' }]));
      assert.deepEqual(result.errors, ['locked/new.png: Folder is not writable', 'locked/new.txt: Folder is not writable']);
    } finally {
      await chmod(path.join(root, 'locked'), 0o755);
    }
  });
});

test('paste UI text: non-text count and size, corrupt and unchanged rows, reasons in user text, failed rows counted as skipped', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'same.png'), PNG);
    await writeFile(path.join(root, 'old.txt'), 'old');
    await mkdir(path.join(root, 'dir.png'));
    const one = Buffer.from([0]);
    const text = [
      payload([
        { path: 'same.png', nonText: PNG },
        { path: 'new.png', nonText: BIG5 },
        { path: 'old.txt', content: 'new' },
        { path: 'dir.png', nonText: PNG }
      ]),
      `// file: bad.bin\n${placeholderLine(1, sha256Hex(one))}\nAB==\n`
    ].join('\n');
    const plan = await markTargetCollisions(await planRestore(root, parseClipboard(text, H)));

    assert.equal(existingTargets(plan), 1, 'the identical target needs no overwrite permission');
    const { message, detail } = confirmationText(plan);
    assert.equal(message, 'Snipcode will create 1, overwrite 1, delete 0, and skip 2 operation(s).');
    assert.deepEqual(detail.split('\n'), [
      `Non-text files: 2 (${(PNG.length + BIG5.length)} B)`,
      'Unchanged (identical bytes already there): 1 (same.png)',
      'The target is a folder: dir.png',
      'Corrupt non-text file: bad.bin'
    ]);
    assert.doesNotMatch(detail, /[A-Z]+_[A-Z_]+/, 'no raw reason codes');

    const result = await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(resultNotice(plan, result), 'Created 1, Overwritten 1, Unchanged 1, Skipped 2');
    assert.equal(resultNotice(plan, { ...result, errors: ['x: Folder is not writable'] }), 'Created 1, Overwritten 1, Unchanged 1, Skipped 3');
  });
});

test('target identity folds NFC/NFD only on a case-insensitive volume', async () => {
  await withRoot(async root => {
    // Not yet on disk, so realpath anchors on the root and the basenames stay as spelled.
    const nfc = 'café.txt';
    const nfd = 'café.txt';
    const op = (name: string) => ({
      relativePath: name, absolutePath: path.join(root, name), content: 'x', existed: false, rootPath: root
    });
    const plan = { roots: [root], createOperations: [op(nfc), op(nfd)], deleteOperations: [], skippedOperations: [] };

    // Case-sensitive (Linux ext4): two distinct files, nothing collides.
    const sensitive = await markTargetCollisions(plan, async () => false);
    assert.deepEqual(sensitive.createOperations.map(o => o.relativePath), [nfc, nfd]);
    assert.deepEqual(sensitive.skippedOperations, []);

    // Case-insensitive (APFS, NTFS): one file, both entries are TARGET_COLLISION.
    const insensitive = await markTargetCollisions(plan, async () => true);
    assert.deepEqual(insensitive.createOperations, []);
    assert.deepEqual(insensitive.skippedOperations.map(s => s.reason), ['TARGET_COLLISION', 'TARGET_COLLISION']);
  });
});

test('an overwrite of a hard link alias outside the roots writes a new file', async () => {
  await withRoot(async base => {
    // Mirror of OpenIDEA restore tests an_overwrite_of_a_hard_link_alias_outside_the_roots_writes_a_new_file.
    const root = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.bin'), Buffer.from([0, 1, 2]));
    await link(path.join(outside, 'secret.bin'), path.join(root, 'asset.bin'));
    await writeFile(path.join(outside, 'secret.txt'), 'outside original\n');
    await link(path.join(outside, 'secret.txt'), path.join(root, 'note.txt'));

    const pasted = Buffer.from([0, 9, 9]);
    const { result } = await paste(root, payload([
      { path: 'asset.bin', nonText: pasted },
      { path: 'note.txt', content: 'pasted text' }
    ]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.overwrittenCount, 2);
    // The outside names keep their bytes; the workspace names are new, unlinked files.
    assert.deepEqual(await readFile(path.join(outside, 'secret.bin')), Buffer.from([0, 1, 2]));
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside original\n');
    assert.deepEqual(await readFile(path.join(root, 'asset.bin')), pasted);
    assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'pasted text');
    assert.equal((await stat(path.join(root, 'asset.bin'))).nlink, 1);
    assert.equal((await stat(path.join(root, 'note.txt'))).nlink, 1);
  });
});

test('an overwrite keeps the target permission mode and leaves no temporary file', { skip: process.platform === 'win32' }, async () => {
  await withRoot(async root => {
    for (const [name, write] of [
      ['run.sh', (p: string) => writeTextFile(p, '#!/bin/sh\necho new\n')],
      ['tool.bin', (p: string) => writeBytesFile(p, new Uint8Array([0, 7]))]
    ] as const) {
      const target = path.join(root, name);
      await writeFile(target, 'old');
      await chmod(target, 0o755);
      await write(target);
      assert.equal((await stat(target)).mode & 0o7777, 0o755, name);
    }
    assert.deepEqual((await readdir(root)).sort(), ['run.sh', 'tool.bin']);
  });
});

test('the temporary file is never looser than 0600 while the content is written', { skip: process.platform === 'win32' }, async () => {
  await withRoot(async root => {
    // Spy on the content write: the temp's mode at that moment is what another user could
    // open it with. Opening at 0o666 let a 0600 file's bytes sit world-readable there.
    const probeHandle = await open(path.join(root, '.probe'), 'w');
    const proto = Object.getPrototypeOf(probeHandle) as { writeFile: (this: FileHandle, ...args: unknown[]) => Promise<void> };
    await probeHandle.close();
    await rm(path.join(root, '.probe'));
    const modesDuringWrite: number[] = [];
    const original = proto.writeFile;
    proto.writeFile = async function (this: FileHandle, ...args: unknown[]) {
      modesDuringWrite.push((await this.stat()).mode & 0o7777);
      await original.apply(this, args);
      modesDuringWrite.push((await this.stat()).mode & 0o7777);
    };
    try {
      const secret = path.join(root, 'secret.bin');
      await writeFile(secret, 'old');
      await chmod(secret, 0o600);
      await writeBytesFile(secret, new Uint8Array([1, 2, 3]));
      assert.equal((await stat(secret)).mode & 0o7777, 0o600);

      const script = path.join(root, 'run.sh');
      await writeFile(script, 'old');
      await chmod(script, 0o755);
      await writeTextFile(script, 'new');
      assert.equal((await stat(script)).mode & 0o7777, 0o755);

      // A new file still gets the ordinary mode a plain create would give it.
      const fresh = path.join(root, 'fresh.txt');
      await writeTextFile(fresh, 'new');
      const umask = process.umask();
      assert.equal((await stat(fresh)).mode & 0o7777, 0o666 & ~umask);
    } finally {
      proto.writeFile = original;
    }
    assert.equal(modesDuringWrite.length, 6);
    for (const mode of modesDuringWrite) assert.equal(mode & 0o077, 0, `temp mode ${mode.toString(8)} during write`);
  });
});

test('a failed write removes its temporary file', async () => {
  await withRoot(async root => {
    // The target is a non-empty folder, so the final rename fails.
    await mkdir(path.join(root, 'taken', 'inner'), { recursive: true });
    await assert.rejects(writeBytesFile(path.join(root, 'taken'), new Uint8Array([1])));
    await assert.rejects(writeTextFile(path.join(root, 'taken'), 'x'));
    assert.deepEqual(await readdir(root), ['taken']);
  });
});
