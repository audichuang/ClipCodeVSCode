import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCopyFiles, collectCopyTextFiles } from '../src/copy.js';
import { extractSourceRoot } from '../src/clipboardFormat.js';
import { buildPayload, parseClipboard } from '../src/clipboardFormat.js';
import { executeRestorePlan, hasPathDependencies, planRestore, type RestoreEntry } from '../src/restore.js';
import { defaultSettings } from '../src/settings.js';

test('restores unmatched absolute paths with their entire directory tree', async () => {
  await withTempDir(async root => {
    const paths = [
      [String.raw`D:\Users\author\.m2\repository\library.jar!\com\example\Library$Inner.java`,
        'D/Users/author/.m2/repository/library.jar!/com/example/Library$Inner.java'],
      ['/foreign/checkout/src/New.kt', 'foreign/checkout/src/New.kt'],
      [String.raw`\\server\share\arbitrary\New.txt`, 'server/share/arbitrary/New.txt']
    ];
    const payload = paths.map(([source], index) => `// file: ${source}\ncontent-${index}`).join('\n');
    const entries = parseClipboard(payload, '// file: $FILE_PATH');
    const plan = await planRestore(root, entries);

    assert.deepEqual(plan.createOperations.map(op => op.relativePath), paths.map(([, relative]) => relative));
    assert.deepEqual(plan.skippedOperations, []);
    const result = await executeRestorePlan(plan, { overwriteExisting: false, skipExisting: false });
    assert.equal(result.createdCount, paths.length);
    assert.deepEqual(result.errors, []);
    for (const [index, [, relative]] of paths.entries()) {
      assert.equal(await readFile(path.join(root, relative), 'utf8'), `content-${index}`);
    }
  });
});

test('copies folders recursively, empty files included', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'main');
    // This assertion used to read "skipping empty files" — status quo, not intent. A
    // 0-byte __init__.py / .gitkeep is a real file, IntelliJ copies it, and dropping it
    // here meant the same folder produced a different file set in each tool.
    await writeFile(path.join(root, 'src', 'nested', 'empty.ts'), '');

    const result = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings);

    assert.equal(result.copiedFileCount, 2);
    assert.deepEqual(result.files.map(file => file.path).sort(), ['src/main.ts', 'src/nested/empty.ts']);
    assert.equal(result.files.find(file => file.path === 'src/nested/empty.ts')?.content, '');
  });
});

test('prunes excluded directories during traversal without changing the copied set', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'main');
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep');

    const settings = {
      ...defaultSettings,
      useFilters: true,
      filterRules: [
        { type: 'PATH' as const, action: 'EXCLUDE' as const, value: 'node_modules', enabled: true }
      ]
    };

    const result = await collectCopyFiles(root, [root], settings);

    assert.equal(result.copiedFileCount, 1);
    assert.equal(result.files[0].path, 'src/main.ts');
    assert.ok(!result.payload.includes('node_modules'));
  });
});

test('copies oversized files as skipped markers and preserves wrappers', async () => {
  await withTempDir(async root => {
    const settings = {
      ...defaultSettings,
      preText: '<files>',
      postText: '</files>',
      maxFileSizeKB: 1
    };
    const large = `${'x'.repeat(1100)}`;
    await writeFile(path.join(root, 'large.txt'), large);

    const result = await collectCopyFiles(root, [path.join(root, 'large.txt')], settings);

    assert.equal(result.copiedFileCount, 0);
    assert.equal(result.skippedFileSizeCount, 1);
    // Leading line is source-root metadata (root basename); the rest is the body.
    assert.equal(extractSourceRoot(result.payload), path.basename(root));
    const body = result.payload.slice(result.payload.indexOf('\n') + 1);
    assert.equal(body, `<files>
// file: large.txt
// File skipped: size exceeds limit (1100 bytes)

// clipcode-end
</files>`);
  });
});

test('copies open editor text through the same filters, limits, and multi-root paths', async () => {
  await withTempDir(async parent => {
    const primary = path.join(parent, 'app');
    const sibling = path.join(parent, 'shared-lib');
    const settings = {
      ...defaultSettings,
      useFilters: true,
      filterRules: [
        { type: 'PATTERN' as const, action: 'EXCLUDE' as const, value: '*.log', enabled: true }
      ]
    };

    const result = await collectCopyTextFiles([primary, sibling], [
      { absolutePath: path.join(primary, 'src', 'main.ts'), content: 'main' },
      { absolutePath: path.join(primary, 'debug.log'), content: 'debug' },
      { absolutePath: path.join(sibling, 'src', 'util.ts'), content: 'util' }
    ], settings);

    assert.equal(result.copiedFileCount, 2);
    assert.deepEqual(result.files.map(file => file.path), [
      'src/main.ts',
      'shared-lib/src/util.ts'
    ]);
  });
});

test('stops copying after the copied-file limit without counting skipped markers', async () => {
  await withTempDir(async root => {
    const settings = {
      ...defaultSettings,
      maxFileSizeKB: 1,
      fileCountLimit: 1
    };

    const result = await collectCopyTextFiles(root, [
      { absolutePath: path.join(root, 'large.txt'), content: 'x'.repeat(1100) },
      { absolutePath: path.join(root, 'a.ts'), content: 'a' },
      { absolutePath: path.join(root, 'b.ts'), content: 'b' }
    ], settings);

    assert.equal(result.copiedFileCount, 1);
    assert.equal(result.skippedFileSizeCount, 1);
    assert.equal(result.fileLimitReached, true);
    assert.deepEqual(result.files.map(file => file.path), ['large.txt', 'a.ts']);
  });
});

test('restore creates, skips, overwrites, and deletes under workspace root', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'old.ts'), 'old');
    await writeFile(path.join(root, 'src', 'delete.ts'), 'delete');

    const entries: RestoreEntry[] = [
      { path: 'src/new.ts', content: 'new', changeTypes: new Set<string>() },
      { path: 'src/old.ts', content: 'updated', changeTypes: new Set<string>() },
      { path: 'src/delete.ts', content: '', changeTypes: new Set(['DELETED' as const]) },
      { path: '../bad.ts', content: 'bad', changeTypes: new Set<string>() }
    ];

    const plan = await planRestore(root, entries);
    assert.equal(plan.createOperations.length, 2);
    assert.equal(plan.deleteOperations.length, 1);
    assert.equal(plan.skippedOperations.length, 1);

    const skipped = await executeRestorePlan(plan, { overwriteExisting: false, skipExisting: true });
    assert.equal(skipped.createdCount, 1);
    assert.equal(skipped.skippedExistingCount, 1);
    assert.equal(await readFile(path.join(root, 'src', 'old.ts'), 'utf8'), 'old');

    const overwritePlan = await planRestore(root, entries.slice(1, 2));
    const overwritten = await executeRestorePlan(overwritePlan, { overwriteExisting: true, skipExisting: false });
    assert.equal(overwritten.overwrittenCount, 1);
    assert.equal(await readFile(path.join(root, 'src', 'old.ts'), 'utf8'), 'updated');

    await executeRestorePlan({ ...plan, createOperations: [] }, { overwriteExisting: false, skipExisting: false });
    await assert.rejects(readFile(path.join(root, 'src', 'delete.ts'), 'utf8'));
  });
});

test('restore writes a large multi-file batch identically (parallelized creates)', async () => {
  await withTempDir(async root => {
    const count = 50;
    const entries: RestoreEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({ path: `src/file-${i}.ts`, content: `content-${i}`, changeTypes: new Set<string>() });
    }
    // One pre-existing file to exercise the skip/overwrite branch under concurrency.
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'file-0.ts'), 'stale');

    const plan = await planRestore(root, entries);
    assert.equal(plan.createOperations.length, count);

    const result = await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(result.createdCount, count - 1);
    assert.equal(result.overwrittenCount, 1);
    assert.equal(result.skippedExistingCount, 0);
    assert.equal(result.errors.length, 0);

    for (let i = 0; i < count; i++) {
      assert.equal(await readFile(path.join(root, 'src', `file-${i}.ts`), 'utf8'), `content-${i}`);
    }
  });
});

test('duplicate-path create ops keep sequential overwrite/skip semantics under parallelism', async () => {
  await withTempDir(async root => {
    // Two entries resolving to the SAME path: the serial loop creates once then
    // overwrites; parallel creates must not both see "absent" and double-count.
    const entries: RestoreEntry[] = [
      { path: 'src/dup.ts', content: 'first', changeTypes: new Set<string>() },
      { path: 'src/dup.ts', content: 'second', changeTypes: new Set<string>() }
    ];
    const plan = await planRestore(root, entries);
    assert.equal(plan.createOperations.length, 2);

    const result = await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(result.createdCount, 1);
    assert.equal(result.overwrittenCount, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(await readFile(path.join(root, 'src', 'dup.ts'), 'utf8'), 'second');
  });
});

test('hasPathDependencies flags duplicates and ancestor/descendant paths, not prefix lookalikes', () => {
  assert.equal(hasPathDependencies(['/r/a.ts', '/r/b.ts']), false);
  assert.equal(hasPathDependencies(['/r/a.ts', '/r/a.ts']), true);            // exact duplicate
  assert.equal(hasPathDependencies(['/r/src', '/r/src/a.ts']), true);         // ancestor dir written as a file
  assert.equal(hasPathDependencies(['/r/src', '/r/srcfoo']), false);          // prefix lookalike, not a real ancestor
  assert.equal(hasPathDependencies(['/r/a/b/c.ts', '/r/a']), true);           // deep descendant
});

test('restore uses sibling root labels and skips ambiguous legacy paths', async () => {
  await withTempDir(async parent => {
    const primary = path.join(parent, 'app');
    const sibling = path.join(parent, 'shared-lib');
    await mkdir(path.join(primary, 'src'), { recursive: true });
    await mkdir(path.join(sibling, 'src'), { recursive: true });
    await writeFile(path.join(primary, 'src', 'same.ts'), 'primary');
    await writeFile(path.join(sibling, 'src', 'same.ts'), 'sibling');

    const entries: RestoreEntry[] = [
      { path: 'shared-lib/src/new.ts', content: 'new', changeTypes: new Set<string>() },
      { path: 'src/same.ts', content: 'ambiguous', changeTypes: new Set<string>() }
    ];

    const plan = await planRestore([primary, sibling], entries);

    assert.equal(plan.createOperations.length, 1);
    assert.equal(plan.createOperations[0].absolutePath, path.join(sibling, 'src', 'new.ts'));
    assert.equal(plan.skippedOperations.length, 1);
    assert.equal(plan.skippedOperations[0].reason, 'AMBIGUOUS_PATH');
  });
});

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipcode-vscode-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('placeholder bodies are skipped instead of overwriting the real file', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'big.log'), 'the real 1.2 MB file');

    const entries: RestoreEntry[] = [
      { path: 'src/big.log', content: '// File skipped: size exceeds limit (1234567 bytes)', changeTypes: new Set() },
      { path: 'src/unreadable.ts', content: '// Unable to read file content', changeTypes: new Set() },
      { path: 'src/failed.ts', content: '// Error reading file content', changeTypes: new Set() },
      // Deliberately inverted: this used to be restored because the body was multi-line.
      // That is exactly how a configured footer switched the guard off and let a stub
      // overwrite a real 1100-byte file. The guard now reads the FIRST line, so trailing
      // noise cannot disarm it. A genuine file whose first line is this marker is the
      // accepted false positive — the string is one this tool invents.
      { path: 'src/real.ts', content: '// File skipped: size exceeds limit (1 bytes)\nbut there is real content too', changeTypes: new Set() }
    ];

    const plan = await planRestore(root, entries);
    assert.deepEqual(plan.createOperations.map(o => o.relativePath), []);
    assert.equal(plan.skippedOperations.length, 4);
    assert.ok(plan.skippedOperations.every(o => o.reason === 'PLACEHOLDER_BODY'));

    await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(await readFile(path.join(root, 'src', 'big.log'), 'utf8'), 'the real 1.2 MB file');
  });
});

test('full chain: a footer must not turn a size-skipped placeholder back into file content', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    const original = 'x'.repeat(1100);
    await writeFile(path.join(root, 'src', 'large.txt'), original);

    // Exactly the reported repro: the copy side substitutes a skip comment, and a
    // configured footer follows it. The footer used to be accumulated INTO that file's
    // body, making it multi-line, which defeated the placeholder guard entirely.
    const postText = '</files>';
    const payload = buildPayload({
      headerFormat: '// file: $FILE_PATH',
      preText: '',
      postText,
      addExtraLineBetweenFiles: true,
      files: [{ path: 'src/large.txt', skippedReason: 'size exceeds limit (1100 bytes)' }]
    });
    assert.ok(payload.includes('// File skipped: size exceeds limit (1100 bytes)'));
    assert.ok(payload.trimEnd().endsWith(postText), 'the footer must really be in the payload');

    // A clipboard round-trip can append a final newline or rewrite the endings as CRLF.
    for (const [name, text] of [
      ['as built', payload],
      ['trailing newline', payload + '\n'],
      ['CRLF', payload.replaceAll('\n', '\r\n')]
    ] as const) {
      const parsed = parseClipboard(text, '// file: $FILE_PATH');
      assert.equal(parsed.length, 1, name);
      assert.ok(!parsed[0].content.includes(postText), `the footer must not land in the file body (${name})`);
    }

    // The guard must hold even when the footer DOES reach the body — a payload from an
    // older release carries no end marker, and no setting on this side can rescue it.
    const legacy = payload.split('\n').filter(line => line !== '// clipcode-end').join('\n');
    const legacyEntries = parseClipboard(legacy, '// file: $FILE_PATH');
    assert.ok(legacyEntries[0].content.includes(postText), 'the legacy shape really does glue the footer on');
    const legacyPlan = await planRestore(root, legacyEntries);
    assert.deepEqual(legacyPlan.createOperations, [], 'a placeholder must never be written');
    assert.equal(legacyPlan.skippedOperations[0]?.reason, 'PLACEHOLDER_BODY');

    const entries = parseClipboard(payload, '// file: $FILE_PATH');
    const plan = await planRestore(root, entries);
    assert.deepEqual(plan.createOperations, [], 'a placeholder must never be written');
    assert.equal(plan.skippedOperations[0]?.reason, 'PLACEHOLDER_BODY');

    await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(await readFile(path.join(root, 'src', 'large.txt'), 'utf8'), original,
      'the real 1100-byte file must survive');
  });
});

test('a foreign payload keeps a real closing line that looks like a footer', async () => {
  // The first attempt at this reconstructed the footer from the RECEIVER's postText and
  // subtracted it from the tail, so a markdown file ending in a code fence lost the fence
  // and a file whose whole content was the footer text was written out EMPTY. The end
  // marker is on the wire, so a payload that never carried a footer is untouched.
  const foreign = '// file: doc.md\n# Title\n\n```js\ncode()\n```';
  const entries = parseClipboard(foreign, '// file: $FILE_PATH');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, '# Title\n\n```js\ncode()\n```', 'the closing fence must survive');

  const license = parseClipboard('// file: LICENSE\nThanks.', '// file: $FILE_PATH');
  assert.equal(license[0].content, 'Thanks.', 'a file whose content IS the footer text must survive');
});

test('full chain: a footer is not appended to the last real file either', async () => {
  await withTempDir(async root => {
    const postText = 'Please review the code above.';
    const payload = buildPayload({
      headerFormat: '// file: $FILE_PATH',
      preText: 'HEADER NOTE',
      postText,
      addExtraLineBetweenFiles: true,
      files: [{ path: 'src/A.ts', content: 'class A' }, { path: 'src/B.ts', content: 'class B' }]
    });
    const entries = parseClipboard(payload, '// file: $FILE_PATH');
    assert.equal(entries.length, 2);
    assert.equal(entries[1].content, 'class B', 'the footer must not be glued onto the last file');

    const plan = await planRestore(root, entries);
    await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.equal(await readFile(path.join(root, 'src', 'B.ts'), 'utf8'), 'class B');
  });
});

test('one unreadable file does not abort the whole folder copy', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'a');
    await writeFile(path.join(root, 'src', 'b.ts'), 'b');
    // A dangling symlink is yielded by the walker and then fails to stat. The reads run
    // under Promise.all, so this one rejection used to propagate out of collectCopyFiles
    // and the clipboard was left untouched — nothing copied, no message. Broken links in
    // node_modules and root-owned files make this ordinary.
    await symlink(path.join(root, 'nowhere'), path.join(root, 'src', 'dangling.ts'));

    const result = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings);

    assert.deepEqual(result.files.map(f => f.path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(result.copiedFileCount, 2);
    assert.equal(result.skippedUnreadableCount, 1, 'the dropped file must be counted, not silent');
  });
});

test('a directory symlink is walked, and a cycle back up its own branch stops', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'packages', 'ui'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'ui', 'index.ts'), 'ui');
    // pnpm and Bazel layouts are built out of these. Refusing to descend meant selecting
    // the linked folder copied NOTHING at all; IntelliJ walks it.
    await symlink(path.join(root, 'packages', 'ui'), path.join(root, 'node_modules', 'ui'), 'dir');
    // A link pointing back at an ancestor must not loop forever.
    await symlink(root, path.join(root, 'packages', 'loop'), 'dir');

    const direct = await collectCopyFiles(root, [path.join(root, 'node_modules', 'ui')], defaultSettings);
    assert.deepEqual(direct.files.map(f => f.path), ['node_modules/ui/index.ts']);

    const whole = await collectCopyFiles(root, [path.join(root, 'packages')], defaultSettings);
    assert.ok(whole.files.some(f => f.path === 'packages/ui/index.ts'));
  });
});

test('a non-UTF-8 file on disk is never overwritten with UTF-8 bytes', async () => {
  await withTempDir(async root => {
    // Big5 for a CJK word: valid text in IntelliJ with the right project charset, and
    // invalid UTF-8. The wire format carries no encoding, so writing the payload back as
    // UTF-8 changes the file's encoding with nothing said and nothing able to undo it.
    const big5 = Buffer.from([0xa4, 0xe9, 0xa5, 0xbb, 0x0a]);
    await writeFile(path.join(root, 'legacy.txt'), big5);
    await writeFile(path.join(root, 'plain.txt'), 'ascii\n');

    const plan = await planRestore(root, [
      { path: 'legacy.txt', content: 'replacement', changeTypes: new Set<string>() },
      { path: 'plain.txt', content: 'replacement', changeTypes: new Set<string>() }
    ]);

    assert.deepEqual(plan.createOperations.map(o => o.relativePath), ['plain.txt']);
    assert.equal(plan.skippedOperations[0]?.reason, 'NON_UTF8_TARGET');

    await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.deepEqual(await readFile(path.join(root, 'legacy.txt')), big5, 'the original bytes must survive');
    assert.equal(await readFile(path.join(root, 'plain.txt'), 'utf8'), 'replacement');
  });
});

test('a non-UTF-8 file is skipped on copy and counted, not silently dropped', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'ok.ts'), 'ok');
    await writeFile(path.join(root, 'src', 'legacy.txt'), Buffer.from([0xa4, 0xe9, 0xa5, 0xbb]));

    const result = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings);

    assert.deepEqual(result.files.map(f => f.path), ['src/ok.ts']);
    assert.equal(result.skippedUnreadableCount, 1, 'the notification must be able to say so');
  });
});

test('a target whose encoding cannot be verified is not overwritten either', async () => {
  await withTempDir(async root => {
    const unreadable = path.join(root, 'unreadable.bin');
    await writeFile(unreadable, Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    await chmod(unreadable, 0o200); // writable, not readable

    try {
      // Treating a failed read as "not non-UTF-8" authorised overwriting exactly the files
      // we could say least about. The check fails CLOSED now.
      const plan = await planRestore(root, [
        { path: 'unreadable.bin', content: 'replacement', changeTypes: new Set<string>() }
      ]);
      assert.deepEqual(plan.createOperations, []);
      assert.equal(plan.skippedOperations[0]?.reason, 'NON_UTF8_TARGET');
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});

test('the encoding verdict is re-taken at write time, not trusted from plan time', async () => {
  await withTempDir(async root => {
    const target = path.join(root, 'race.txt');
    await writeFile(target, 'original');

    const plan = await planRestore(root, [
      { path: 'race.txt', content: 'replacement', changeTypes: new Set<string>() }
    ]);
    assert.equal(plan.createOperations.length, 1, 'ASCII target plans fine');

    // The user then clicks through the confirmation dialogs, and in that window the file
    // is replaced with non-UTF-8 bytes. A plan-time verdict is not a verdict on the bytes
    // being overwritten later.
    const big5 = Buffer.from([0xa4, 0xe9, 0xa5, 0xbb]);
    await writeFile(target, big5);

    await executeRestorePlan(plan, { overwriteExisting: true, skipExisting: false });
    assert.deepEqual(await readFile(target), big5, 'the bytes that were actually there must survive');
  });
});
