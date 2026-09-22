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
  // Keep the root missing: on macOS /tmp is a symlink, so containment must canonicalize
  // the nearest existing parent on both the target and root sides.
  const root = path.resolve('/tmp/project');
  const resolved = resolveRestoreTarget(root, 'src/main.ts');
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.relativePath, 'src/main.ts');
    assert.equal(resolved.absolutePath, path.join(root, 'src', 'main.ts'));
  }
});

test('rejects traversal and invalid segments while nesting unmapped absolute paths', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(resolveRestoreTarget(root, '../secret.txt').ok, false);
  assert.equal(resolveRestoreTarget(root, 'src/bad:name.ts').ok, false);
  // Row 5 of the cross-tool contract: an absolute path matching no root is kept LITERALLY
  // under the primary root — never guessed onto a tail, never written outside it. So this is
  // `<root>/etc/passwd`, exactly as IntelliJ 1.2.14+ restores it.
  const absolute = resolveRestoreTarget(root, '/etc/passwd');
  assert.ok(absolute.ok);
  assert.equal(absolute.absolutePath, path.join(root, 'etc', 'passwd'));
  assert.equal(resolveRestoreTarget(root, 'D:/foreign/../secret.txt').ok, false);
  assert.equal(resolveRestoreTarget(root, '/foreign/../secret.txt').ok, false);
  assert.equal(resolveRestoreTarget(root, 'D:/foreign/bad:name.txt').ok, false);
});

test('literal absolute fallback stays in the primary root and never remaps deletes', async () => {
  await withTempDir(async parent => {
    const root = path.join(parent, 'project');
    const sibling = path.join(parent, 'backup');
    const outside = path.join(parent, 'outside');
    await mkdir(root);
    await mkdir(sibling);
    await mkdir(outside);
    // The fallback's first segment matches a sibling label; it is still literal.
    const resolved = resolveWriteTarget([root, sibling], '/backup/backup/new.txt');
    assert.ok(resolved.ok);
    assert.equal(resolved.absolutePath, path.join(root, 'backup/backup/new.txt'));
    const unmapped = resolveWriteTarget([root, sibling], '/unmapped/source.txt');
    assert.ok(unmapped.ok);
    assert.equal(unmapped.absolutePath, path.join(root, 'unmapped/source.txt'));
    await mkdir(path.join(root, 'D'), { recursive: true });
    await writeFile(path.join(root, 'D', 'keep.txt'), 'keep');
    assert.equal(resolveDeleteTarget([root], 'D:/keep.txt').ok, false);
    await symlink(outside, path.join(root, 'escaped'), 'dir');
    assert.equal(resolveWriteTarget([root], '/escaped/new.txt').ok, false);
  });
});

test('a drive path with a line terminator in a name is still a Windows path', async () => {
  // `.` in the drive regexes skipped these (JS skips four, Java five — U+0085 too), a lone \r
  // survives the \r?\n header split, and the two tools then disagreed: the path was not
  // Windows-style, so the cross-machine suffix compared `PROJ` to the root `proj`
  // case-sensitively and missed it. Mirrors ClipboardPathResolverTest on the IntelliJ side.
  await withTempDir(async parent => {
    const root = path.join(parent, 'proj');
    await mkdir(root);
    // U+0085/U+2028/U+2029 are legal file-name characters on every platform.
    for (const terminator of ['\u0085', '\u2028', '\u2029']) {
      const literal = resolveWriteTarget([root], `D:/a${terminator}b.txt`);
      assert.ok(literal.ok);
      assert.equal(literal.absolutePath, path.join(root, 'D', `a${terminator}b.txt`));
      const suffix = resolveWriteTarget([root], `D:/elsewhere/PROJ/a${terminator}b.ts`);
      assert.ok(suffix.ok);
      assert.equal(suffix.absolutePath, path.join(root, `a${terminator}b.ts`));
    }
    // A control character is not, on Windows — so both tools refuse it everywhere.
    for (const control of ['\r', '\n', '\t', '\u001C']) {
      assert.equal(resolveWriteTarget([root], `D:/a${control}b.txt`).ok, false);
      assert.equal(resolveWriteTarget([root], `D:/elsewhere/PROJ/a${control}b.ts`).ok, false);
      assert.equal(resolveWriteTarget([root], `/a${control}b.txt`).ok, false);
    }
  });
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

test('write targets may follow a symlink that stays inside, never one that escapes', async () => {
  await withTempDir(async parent => {
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    await mkdir(path.join(root, 'packages', 'ui'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await symlink(outside, path.join(root, 'linked'), 'dir');
    // pnpm's node_modules layout is exactly this: a link that never leaves the workspace.
    await symlink(path.join(root, 'packages', 'ui'), path.join(root, 'node_modules', 'ui'), 'dir');

    const escaping = resolveWriteTarget([root], 'linked/escape.ts');
    assert.equal(escaping.ok, false);
    if (!escaping.ok) assert.equal(escaping.reason, 'unsafe path');

    // Refusing every symlink component locked these users out of restore entirely, and
    // disagreed with IntelliJ, which resolves the same path happily.
    assert.equal(resolveWriteTarget([root], 'node_modules/ui/index.ts').ok, true);
  });
});

test('a workspace root that does not exist yet is canonicalized like its targets', async () => {
  // Builds its own symlink instead of relying on the host: on macOS /tmp IS a symlink to
  // /private/tmp, so the bug this guards reproduced there and was INVISIBLE on Linux — the
  // whole suite stayed green with the fix reverted. A test that can only fail on one OS is
  // not a guard, so the condition is constructed here and the assertion holds everywhere.
  //
  // The bug: containmentTarget() resolves the target through its deepest EXISTING ancestor,
  // but the ROOT side used realpath and gave up when the root itself did not exist yet,
  // returning the unresolved path. The two then lived in different namespaces and a
  // perfectly safe create was refused as an escape.
  await withTempDir(async parent => {
    const real = path.join(parent, 'real');
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(parent, 'link'), 'dir');

    // Reached through the link, and not created yet — exactly a fresh restore destination.
    const root = path.join(parent, 'link', 'workspace');
    const resolved = resolveWriteTarget([root], 'src/New.ts');
    assert.equal(resolved.ok, true, 'a safe create under a not-yet-created root must be allowed');

    // The guard itself must still bite: a link inside that root pointing out of it escapes.
    const escapeRoot = path.join(parent, 'link', 'ws2');
    await mkdir(path.join(real, 'ws2'), { recursive: true });
    await symlink(path.join(parent, 'outside'), path.join(real, 'ws2', 'out'), 'dir');
    await mkdir(path.join(parent, 'outside'), { recursive: true });
    const escaping = resolveWriteTarget([escapeRoot], 'out/escape.ts');
    assert.equal(escaping.ok, false, 'a link leaving the root must still be refused');
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

test('an external root keeps its identity through cross-machine suffix matching', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-multiroot-'));
  try {
    const app = path.join(base, 'dest', 'app');
    const shared = path.join(base, 'dest', 'shared-lib');
    // The primary repo also contains a same-named folder — that collision is what made
    // the label ambiguous and pushed resolution onto the suffix path in the first place.
    await mkdir(path.join(app, 'shared-lib'), { recursive: true });
    await mkdir(shared, { recursive: true });

    // A payload copied on another machine carries the external file's absolute path.
    const resolution = resolveWriteTarget([app, shared], '/source/shared-lib/new.ts');

    assert.equal(resolution.ok, true, 'must resolve, not fall through');
    if (!resolution.ok) return;
    assert.equal(
      path.resolve(resolution.absolutePath),
      path.join(shared, 'new.ts'),
      'must land in the external root, not be written over the primary repo'
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('deletion must not escape the workspace through a directory symlink', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-symdel-'));
  try {
    const repo = path.join(base, 'repo');
    const outside = path.join(base, 'outside');
    await mkdir(repo, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'keep.txt'), 'must survive');
    await symlink(outside, path.join(repo, 'link'), 'dir');

    // The write resolver already refused this; deletion had no check at all and really
    // removed the file outside the workspace.
    const del = resolveDeleteTarget([repo], 'link/keep.txt');
    assert.equal(del.ok, false, 'must refuse to delete outside the workspace');

    // A path that stays inside the workspace is still deletable.
    await writeFile(path.join(repo, 'inside.txt'), 'x');
    assert.equal(resolveDeleteTarget([repo], 'inside.txt').ok, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a relative leaf symlink is resolved against its REAL parent, not the way in', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-lexical-'));
  try {
    const ws = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(ws, 'sub'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'x'), 'must survive');
    // Walking IN through a directory symlink and then following a RELATIVE leaf link:
    // resolving the link text against the walked-in path fabricates an in-workspace answer
    // and the write lands outside. Only a real resolve gets this right — this exact layout
    // was refused by the old "any symlink component" rule and must stay refused.
    await symlink(ws, path.join(ws, 'sub', 'dirlink'), 'dir');
    await symlink(path.join('..', 'outside', 'x'), path.join(ws, 'file'));

    assert.equal(resolveWriteTarget([ws], 'sub/dirlink/file').ok, false, 'must not write outside');
    assert.equal(resolveDeleteTarget([ws], 'sub/dirlink/file').ok, false, 'must not delete outside');

    // Same shape, but the leaf link dangles — the target does not exist yet.
    await symlink(path.join('..', 'outside', 'brand-new.txt'), path.join(ws, 'newfile'));
    assert.equal(resolveWriteTarget([ws], 'sub/dirlink/newfile').ok, false, 'must not create outside');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('containment holds however many missing levels sit under an escaping link', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-deep-'));
  try {
    const repo = path.join(base, 'repo');
    const outside = path.join(base, 'outside');
    await mkdir(repo, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(repo, 'link'), 'dir');

    // A fixed iteration budget counted MISSING ANCESTORS, so a path with more levels than
    // the budget gave up before reaching the link above them — and gave up by ALLOWING.
    const deep = ['link', ...Array(42).fill('d'), 'new.txt'].join('/');
    assert.equal(resolveWriteTarget([repo], deep).ok, false, 'depth must not buy a way out');
    assert.equal(resolveWriteTarget([repo], 'link/new.txt').ok, false);

    // And a deep path that stays inside is still writable.
    const inside = [...Array(42).fill('d'), 'new.txt'].join('/');
    assert.equal(resolveWriteTarget([repo], inside).ok, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a literal backslash in a real directory name is not read as a separator', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-backslash-'));
  try {
    const repo = path.join(base, 'repo');
    // A POSIX directory whose NAME contains a backslash. Slash-normalising the resolved
    // path rewrote it to `repo/outside`, which reads as being inside `repo` — and the
    // write landed in this sibling instead.
    const sibling = path.join(base, 'repo\\outside');
    await mkdir(repo, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, path.join(repo, 'backlink'), 'dir');

    assert.equal(resolveWriteTarget([repo], 'backlink/new.txt').ok, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
