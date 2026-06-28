import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCopyFiles, collectCopyTextFiles } from '../src/copy.js';
import { executeRestorePlan, planRestore, type RestoreEntry } from '../src/restore.js';
import { defaultSettings } from '../src/settings.js';

test('copies folders recursively while skipping empty files', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'main');
    await writeFile(path.join(root, 'src', 'nested', 'empty.ts'), '');

    const result = await collectCopyFiles(root, [path.join(root, 'src')], defaultSettings);

    assert.equal(result.files.length, 1);
    assert.equal(result.copiedFileCount, 1);
    assert.equal(result.files[0].path, 'src/main.ts');
    assert.equal(result.files[0].content, 'main');
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
    assert.equal(result.payload, `<files>
// file: large.txt
// File skipped: size exceeds limit (1100 bytes)

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
