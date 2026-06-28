import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveDeleteTarget,
  resolveRestoreTarget,
  resolveWriteTarget,
  toClipboardPath,
  toClipboardPathFromRoots
} from '../src/pathResolver.js';

test('converts workspace files to slash-separated clipboard paths', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(toClipboardPath(root, path.join(root, 'src', 'main.ts')), 'src/main.ts');
});

test('keeps windows-style clipboard paths slash-separated', () => {
  assert.equal(toClipboardPath('C:/repo/app', 'C:\\repo\\app\\src\\main.ts'), 'src/main.ts');
});

test('labels files from sibling workspace roots', async () => {
  await withTempDir(async parent => {
    const primary = path.join(parent, 'app');
    const sibling = path.join(parent, 'shared-lib');
    await mkdir(path.join(primary, 'src'), { recursive: true });
    await mkdir(path.join(sibling, 'src'), { recursive: true });

    assert.equal(
      toClipboardPathFromRoots([primary, sibling], path.join(sibling, 'src', 'util.ts')),
      'shared-lib/src/util.ts'
    );
    assert.equal(
      toClipboardPathFromRoots([primary, sibling], path.join(primary, 'src', 'main.ts')),
      'src/main.ts'
    );
  });
});

test('resolves safe restore target under workspace root', () => {
  const root = path.resolve('/tmp/project');
  const resolved = resolveRestoreTarget(root, 'src/main.ts');
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.relativePath, 'src/main.ts');
    assert.equal(resolved.absolutePath, path.join(root, 'src', 'main.ts'));
  }
});

test('rejects restore targets outside workspace or with invalid segments', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(resolveRestoreTarget(root, '../secret.txt').ok, false);
  assert.equal(resolveRestoreTarget(root, 'src/bad:name.ts').ok, false);
  assert.equal(resolveRestoreTarget(root, '/etc/passwd').ok, false);
});

test('resolves explicit sibling root labels for restore', async () => {
  await withTempDir(async parent => {
    const primary = path.join(parent, 'app');
    const sibling = path.join(parent, 'shared-lib');
    await mkdir(primary, { recursive: true });
    await mkdir(sibling, { recursive: true });

    const resolved = resolveWriteTarget([primary, sibling], 'shared-lib/src/New.ts');

    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.relativePath, 'src/New.ts');
      assert.equal(resolved.absolutePath, path.join(sibling, 'src', 'New.ts'));
    }
  });
});

test('marks existing files across roots as ambiguous', async () => {
  await withTempDir(async parent => {
    const primary = path.join(parent, 'app');
    const sibling = path.join(parent, 'shared-lib');
    await mkdir(path.join(primary, 'src'), { recursive: true });
    await mkdir(path.join(sibling, 'src'), { recursive: true });
    await writeFile(path.join(primary, 'src', 'App.ts'), 'primary');
    await writeFile(path.join(sibling, 'src', 'App.ts'), 'sibling');

    const writeResolution = resolveWriteTarget([primary, sibling], 'src/App.ts');
    assert.equal(writeResolution.ok, false);
    if (!writeResolution.ok) {
      assert.equal(writeResolution.reason, 'ambiguous path');
    }

    const deleteResolution = resolveDeleteTarget([primary, sibling], 'src/App.ts');
    assert.equal(deleteResolution.ok, false);
    if (!deleteResolution.ok) {
      assert.equal(deleteResolution.reason, 'ambiguous path');
    }
  });
});

test('accepts absolute restore paths under known roots', async () => {
  await withTempDir(async root => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    const resolved = resolveWriteTarget([root], path.join(root, 'src', 'App.ts'));

    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.relativePath, 'src/App.ts');
      assert.equal(resolved.absolutePath, path.join(root, 'src', 'App.ts'));
    }
  });
});

test('rejects write targets through symlinked path components', async () => {
  await withTempDir(async parent => {
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, 'linked'), 'dir');

    const resolved = resolveWriteTarget([root], 'linked/escape.ts');

    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.equal(resolved.reason, 'unsafe path');
    }
  });
});

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipcode-path-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
