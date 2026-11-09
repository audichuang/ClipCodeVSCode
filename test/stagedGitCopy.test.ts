import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, test } from 'node:test';
import path from 'node:path';
import { parseClipboard } from '../src/clipboardFormat.js';
import { copyNoticeDetails } from '../src/nonTextDialog.js';
import { defaultSettings } from '../src/settings.js';

class Uri {
  constructor(readonly fsPath: string) {}
}

const workspaceReads: string[] = [];
// Working-tree bytes by path; anything absent reads as `working:<path>`.
const workspaceBytes = new Map<string, Uint8Array>();
const workingBytes = (fsPath: string) => workspaceBytes.get(fsPath) ?? new TextEncoder().encode(`working:${fsPath}`);
const vscode = {
  Uri,
  workspace: {
    fs: {
      readFile: async (uri: Uri) => {
        workspaceReads.push(uri.fsPath);
        return workingBytes(uri.fsPath);
      },
      stat: async (uri: Uri) => ({ size: workingBytes(uri.fsPath).length }),
    },
  },
};

const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const extensionModule = import('../src/extension.js');

after(() => { loader._load = originalLoad; });

test('staged Git copy preserves index bytes plus deleted and renamed labels', async () => {
  const index = new Map([
    ['same.ts', 'index:same'],
    ['new.ts', 'index:renamed'],
  ]);
  const head = new Map([['gone.ts', 'head:deleted']]);
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      workingTreeChanges: [
        { uri: new Uri('/repo/same.ts'), status: 'MODIFIED' },
      ],
      indexChanges: [
        { uri: new Uri('/repo/same.ts'), status: 'INDEX_MODIFIED' },
        { uri: new Uri('/repo/gone.ts'), status: 'INDEX_DELETED' },
        {
          uri: new Uri('/repo/old.ts'),
          originalUri: new Uri('/repo/old.ts'),
          renameUri: new Uri('/repo/new.ts'),
          status: 'INDEX_RENAMED',
        },
      ],
    },
    show: async (ref: string, file: string) => {
      const content = (ref === '' ? index : head).get(file);
      if (content === undefined) throw new Error('missing');
      return content;
    },
  };
  const selected = ['same.ts', 'gone.ts', 'new.ts'].map(file => ({
    uriKey: `/repo/${file}`,
    staged: true,
  }));

  const { collectGitPayloadFiles } = await extensionModule;
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, {
    ...defaultSettings,
    setMaxFileCount: false,
  });

  assert.deepEqual(result.files, [
    { path: 'same.ts', content: 'index:same', changeType: 'MODIFIED' },
    { path: 'gone.ts', content: 'head:deleted', changeType: 'DELETED' },
    { path: 'new.ts', content: 'index:renamed', changeType: 'MOVED' },
  ]);
  assert.deepEqual(workspaceReads, []);
});

test('an unreadable index entry is left out, never replaced by the working tree', async () => {
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      indexChanges: [
        { uri: new Uri('/repo/ok.ts'), status: 'INDEX_MODIFIED' },
        { uri: new Uri('/repo/broken.ts'), status: 'INDEX_MODIFIED' },
      ],
    },
    show: async (_ref: string, file: string) => {
      // readRefContent tries the repo-relative spelling and then the absolute one.
      if (file.endsWith('broken.ts')) throw new Error('index read failed');
      return 'index:ok';
    },
  };
  const selected = ['ok.ts', 'broken.ts'].map(file => ({ uriKey: `/repo/${file}`, staged: true }));

  const { collectGitPayloadFiles } = await extensionModule;
  workspaceReads.length = 0;
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, {
    ...defaultSettings,
    setMaxFileCount: false,
  });

  // It used to emit `broken.ts` with `working:/repo/broken.ts` — unstaged bytes under a
  // staged label, with nothing in the payload or the notification saying so. Dropping it
  // was no better: the file just went missing in silence. The marker is visible, and the
  // restore planners refuse to write it over a real file.
  assert.deepEqual(result.files, [
    { path: 'ok.ts', content: 'index:ok', changeType: 'MODIFIED' },
    { path: 'broken.ts', content: '// Unable to read file content', changeType: 'MODIFIED' }
  ]);
  assert.deepEqual(workspaceReads, []);
});

test('an unreadable placeholder is not a copied file and does not consume the limit', async () => {
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      indexChanges: [
        { uri: new Uri('/repo/broken.ts'), status: 'INDEX_MODIFIED' },
        { uri: new Uri('/repo/real.ts'), status: 'INDEX_MODIFIED' }
      ]
    },
    show: async (_ref: string, file: string) => {
      if (file.endsWith('broken.ts')) throw new Error('index read failed');
      return 'index:real';
    }
  };
  const selected = ['broken.ts', 'real.ts'].map(file => ({ uriKey: `/repo/${file}`, staged: true }));

  const { collectGitPayloadFiles } = await extensionModule;
  workspaceReads.length = 0;
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, {
    ...defaultSettings,
    setMaxFileCount: true,
    fileCountLimit: 1
  });

  // The placeholder used to count as a copied file, so a limit of 1 was spent on a note
  // saying nothing could be read while `real.ts` was dropped — and the notification
  // reported one file copied. Mirror of GitClipboardPayloadBuilder on the IntelliJ side.
  assert.deepEqual(result.files, [
    { path: 'broken.ts', content: '// Unable to read file content', changeType: 'MODIFIED' },
    { path: 'real.ts', content: 'index:real', changeType: 'MODIFIED' }
  ]);
  assert.equal(result.copiedFileCount, 1);
  assert.equal(result.skippedUnreadableCount, 1);
  assert.equal(result.fileLimitReached, false);
});

test('working-tree size is checked before decoding, and an unreadable file is counted (IntelliJ order)', async () => {
  workspaceBytes.set('/repo/big.png', new Uint8Array(2048).fill(0));
  workspaceBytes.set('/repo/small.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  const changes = [
    { uri: new Uri('/repo/big.png'), status: 'MODIFIED' },
    { uri: new Uri('/repo/small.png'), status: 'MODIFIED' },
    { uri: new Uri('/repo/a.ts'), status: 'MODIFIED' },
  ];
  const repository = { rootUri: new Uri('/repo'), state: { workingTreeChanges: changes }, show: async () => { throw new Error('no'); } };
  const selected = ['big.png', 'small.png', 'a.ts'].map(file => ({ uriKey: `/repo/${file}` }));
  const { collectGitPayloadFiles } = await extensionModule;

  try {
    const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, { ...defaultSettings, maxFileSizeKB: 1 });
    // Regular layout: the oversized file gets the size placeholder, the small binary is counted
    // and left out (CopyFileContentAction checks size first, then counts unreadable).
    assert.deepEqual(result.files, [
      { path: 'big.png', changeType: 'MODIFIED', skippedReason: 'size exceeds limit (2048 bytes)' },
      { path: 'a.ts', content: 'working:/repo/a.ts', changeType: 'MODIFIED' },
    ]);
    assert.equal(result.skippedFileSizeCount, 1);
    assert.equal(result.skippedUnreadableCount, 1);
    assert.equal(result.copiedFileCount, 1);

    // With a deleted file the Git layout is used, and there IntelliJ's builder keeps the
    // unreadable file as a `// Unable to read file content` entry.
    const withDeleted = {
      ...repository,
      state: { workingTreeChanges: [...changes, { uri: new Uri('/repo/gone.ts'), status: 'DELETED' }] },
      show: async () => 'head:gone',
    };
    const mixed = await collectGitPayloadFiles([withDeleted] as never, ['/repo'],
      [...selected, { uriKey: '/repo/gone.ts' }], { ...defaultSettings, maxFileSizeKB: 1 });
    assert.deepEqual(mixed.files.map(file => [file.path, file.content ?? file.skippedReason]), [
      ['big.png', 'size exceeds limit (2048 bytes)'],
      ['small.png', '// Unable to read file content'],
      ['a.ts', 'working:/repo/a.ts'],
      ['gone.ts', 'head:gone'],
    ]);
    assert.equal(mixed.usesRegularSpacing, false);
    assert.equal(mixed.skippedUnreadableCount, 1);
  } finally {
    workspaceBytes.clear();
  }
});

// ---- Non-text files on the SCM surface (spec non-text-files.md, cases 1, 2, 7, 11) ----

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const BIG5 = new Uint8Array([0xa4, 0xe9, 0xa5, 0xbb]);

test('SCM Include carries non-text working-tree and staged files as Base64; Exclude keeps the old payload', async () => {
  workspaceBytes.set('/repo/logo.png', PNG);
  // 2048 bytes: over a 1 KB text limit, inside the 2048 KB non-text limit.
  workspaceBytes.set('/repo/big.png', new Uint8Array(2048).fill(0));
  workspaceBytes.set('/repo/a.ts', new TextEncoder().encode('text'));
  const index = new Map([['legacy.csv', BIG5]]);
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      workingTreeChanges: [
        { uri: new Uri('/repo/logo.png'), status: 'MODIFIED' },
        { uri: new Uri('/repo/big.png'), status: 'MODIFIED' },
        { uri: new Uri('/repo/a.ts'), status: 'MODIFIED' },
      ],
      indexChanges: [{ uri: new Uri('/repo/legacy.csv'), status: 'INDEX_MODIFIED' }],
    },
    buffer: async (ref: string, file: string) => {
      const bytes = ref === '' ? index.get(file) : undefined;
      if (!bytes) throw new Error('missing');
      return bytes;
    },
  };
  const selected = [
    { uriKey: '/repo/logo.png' }, { uriKey: '/repo/big.png' }, { uriKey: '/repo/a.ts' },
    { uriKey: '/repo/legacy.csv', staged: true },
  ];
  const settings = { ...defaultSettings, maxFileSizeKB: 1 };
  const { collectGitPayloadFiles } = await extensionModule;
  try {
    const include = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, settings, { includeNonText: true });
    assert.deepEqual(include.files, [
      { path: 'logo.png', nonText: PNG, changeType: 'MODIFIED' },
      { path: 'big.png', nonText: new Uint8Array(2048), changeType: 'MODIFIED' },
      { path: 'a.ts', content: 'text', changeType: 'MODIFIED' },
      { path: 'legacy.csv', nonText: BIG5, changeType: 'MODIFIED' },
    ]);
    assert.deepEqual(include.nonTextFiles, [
      { path: 'logo.png', size: PNG.length }, { path: 'big.png', size: 2048 }, { path: 'legacy.csv', size: BIG5.length },
    ]);
    assert.equal(include.nonTextTotalBytes, PNG.length + 2048 + BIG5.length);
    assert.equal(include.copiedFileCount, 4);
    assert.equal(include.skippedUnreadableCount, 0);

    // Exclude, and the default (no options) that every caller used before: the old result.
    const exclude = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, settings, { includeNonText: false });
    const legacy = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, settings);
    assert.deepEqual(exclude, legacy);
    assert.deepEqual(exclude.files, [
      { path: 'logo.png', content: '// Unable to read file content', changeType: 'MODIFIED' },
      { path: 'big.png', changeType: 'MODIFIED', skippedReason: 'size exceeds limit (2048 bytes)' },
      { path: 'a.ts', content: 'text', changeType: 'MODIFIED' },
      { path: 'legacy.csv', content: '// Unable to read file content', changeType: 'MODIFIED' },
    ]);
    assert.deepEqual(exclude.nonTextFiles, []);
    assert.equal(exclude.excludedNonTextCount, 2);
    assert.equal(exclude.skippedUnreadableCount, 2);
  } finally {
    workspaceBytes.clear();
  }
});

test('SCM Include: a non-text file over its own limit is a size placeholder, a deleted one keeps its body', async () => {
  workspaceBytes.set('/repo/huge.png', new Uint8Array(3 * 1024).fill(0));
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      workingTreeChanges: [
        { uri: new Uri('/repo/huge.png'), status: 'MODIFIED' },
        { uri: new Uri('/repo/gone.png'), status: 'DELETED' },
      ],
    },
    // HEAD still has the deleted image's bytes; a [DELETED] body must not carry them.
    buffer: async () => PNG,
  };
  const selected = [{ uriKey: '/repo/huge.png' }, { uriKey: '/repo/gone.png' }];
  const { collectGitPayloadFiles } = await extensionModule;
  try {
    const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected,
      { ...defaultSettings, maxFileSizeKB: 4, maxNonTextFileSizeKB: 2 }, { includeNonText: true });
    assert.deepEqual(result.files, [
      { path: 'huge.png', changeType: 'MODIFIED', skippedReason: 'size exceeds limit (3072 bytes)' },
      { path: 'gone.png', content: '// This file has been deleted in this change', changeType: 'DELETED' },
    ]);
    assert.equal(result.nonTextOverLimitCount, 1);
    assert.deepEqual(result.nonTextFiles, []);
  } finally {
    workspaceBytes.clear();
  }
});

test('SCM Include: non-text files count toward the file-count limit and the left-out count is reported', async () => {
  for (const name of ['a.png', 'b.png', 'c.png']) workspaceBytes.set(`/repo/${name}`, PNG);
  const repository = {
    rootUri: new Uri('/repo'),
    state: { workingTreeChanges: ['a.png', 'b.png', 'c.png'].map(name => ({ uri: new Uri(`/repo/${name}`), status: 'MODIFIED' })) },
  };
  const { collectGitPayloadFiles } = await extensionModule;
  try {
    const result = await collectGitPayloadFiles([repository] as never, ['/repo'], [],
      { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 2 }, { includeNonText: true });
    assert.deepEqual(result.nonTextFiles.map(f => f.path), ['a.png', 'b.png']);
    assert.equal(result.fileLimitReached, true);
    assert.equal(result.limitLeftOut, 1);
  } finally {
    workspaceBytes.clear();
  }
});

test('staged and deleted reads go through the raw reader first (no textconv output)', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      indexChanges: [
        { uri: new Uri('/repo/logo.png'), status: 'INDEX_MODIFIED' },
        { uri: new Uri('/repo/gone.ts'), status: 'INDEX_DELETED' },
      ],
    },
    // What the Git extension returns with a textconv driver configured.
    buffer: async () => new TextEncoder().encode('TEXTCONV OUTPUT\n'),
  };
  const asked: string[] = [];
  const rawReader = async (root: string, ref: string, rel: string) => {
    asked.push(`${root} ${ref}:${rel}`);
    return { bytes: rel === 'logo.png' ? png : new TextEncoder().encode('head:deleted') };
  };
  const selected = ['logo.png', 'gone.ts'].map(file => ({ uriKey: `/repo/${file}`, staged: true }));

  const { collectGitPayloadFiles } = await extensionModule;
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected,
    { ...defaultSettings, setMaxFileCount: false }, { includeNonText: true, rawReader });

  assert.deepEqual(result.files, [
    { path: 'logo.png', nonText: png, changeType: 'MODIFIED' },
    { path: 'gone.ts', content: 'head:deleted', changeType: 'DELETED' },
  ]);
  assert.deepEqual(asked.sort(), ['/repo :logo.png', '/repo HEAD:gone.ts']);
});

test('SCM copy: a non-portable changed path is never read, gets no header, is named, and does not use the file-count limit (X1)', {
  skip: process.platform === 'win32' ? 'Windows cannot create these names' : undefined
}, async () => {
  // Decision X1 (2026-11-09): Git-change copies apply the files copy's rule to each changed
  // path. Before, the relative path fell back to the absolute one and was written into the
  // header as is, so a name holding a newline forged a second header.
  // Its second line is a header the default format reads (the comment marker is optional).
  const injected = 'x\nfile: [DELETED] src/main.rs';
  const names = ['a\\b.png', 'q"x.ts', 'c:d.ts', 't\tab.ts', injected, 'ok 檔 😀.ts', 'later.ts'];
  const shown: string[] = [];
  const repository = {
    rootUri: new Uri('/repo'),
    state: {
      workingTreeChanges: [
        ...names.map(name => ({ uri: new Uri(`/repo/${name}`), status: 'MODIFIED' })),
        // A deleted entry with such a name is skipped too: its header would carry the same name.
        { uri: new Uri('/repo/gone\nfile: y.ts'), status: 'DELETED' }
      ]
    },
    show: async (_ref: string, file: string) => { shown.push(file); return 'head'; }
  };
  workspaceReads.length = 0;
  const { collectGitPayloadFiles, gitChangesPayload, gitNoticeCounts } = await extensionModule;
  const settings = { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 1 };
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], [], settings, { includeNonText: true });

  assert.deepEqual(result.files, [{ path: 'ok 檔 😀.ts', content: 'working:/repo/ok 檔 😀.ts', changeType: 'MODIFIED' }]);
  // Reads run ahead of the bookkeeping (later.ts may be read past the limit), never a refused name.
  assert.deepEqual(workspaceReads.filter(p => !p.endsWith('later.ts')), ['/repo/ok 檔 😀.ts']);
  assert.deepEqual(shown, []);
  assert.equal(result.limitLeftOut, 1, 'only later.ts is left out by the limit');
  assert.equal(result.nonPortableCount, 6);
  assert.deepEqual(result.nonPortablePaths, ['a\\b.png', 'q"x.ts', 'c:d.ts', 't\tab.ts', injected, 'gone\nfile: y.ts']);
  const payload = gitChangesPayload(result, settings, ['/repo']);
  assert.deepEqual(parseClipboard(payload, settings.headerFormat).map(e => e.path), ['ok 檔 😀.ts']);
  assert.ok(copyNoticeDetails(gitNoticeCounts(result))
    .includes('Name not portable: 6 (a\\b.png, q"x.ts, c:d.ts and 3 more).'), copyNoticeDetails(gitNoticeCounts(result)).join('\n'));
});

test('SCM copy: normal names are read and carried with nothing named (X1)', async () => {
  const names = ['src/a.ts', 'my docs/說明 文件.md', 'emoji 😀/🎉.ts'];
  const root = path.resolve('/repo');
  const repository = {
    rootUri: new Uri(root),
    state: { workingTreeChanges: names.map(name => ({ uri: new Uri(path.join(root, ...name.split('/'))), status: 'MODIFIED' })) },
  };
  const { collectGitPayloadFiles } = await extensionModule;
  const result = await collectGitPayloadFiles([repository] as never, [root], [],
    { ...defaultSettings, setMaxFileCount: false }, { includeNonText: false });
  assert.deepEqual(result.files.map(f => f.path), names);
  assert.equal(result.nonPortableCount, 0);
  assert.deepEqual(result.nonPortablePaths, []);
});

// Spec "as the header spells it" (OpenIDEA PR #208): a second workspace root is labelled
// with its folder name in the header, so that name is judged too. `my:repo/a.ts` restores
// nowhere (the paste side's sanitizer changes it), so it is named instead of written.
test('SCM copy judges the header as written: a non-primary root labelled `my:repo` is not portable (X1)', { skip: process.platform === 'win32' ? 'POSIX paths' : undefined }, async () => {
  const repository = {
    rootUri: new Uri('/x/my:repo'),
    state: { workingTreeChanges: [{ uri: new Uri('/x/my:repo/a.ts'), status: 'MODIFIED' }] },
  };
  const okRepo = { rootUri: new Uri('/ws'), state: { workingTreeChanges: [{ uri: new Uri('/ws/b.ts'), status: 'MODIFIED' }] } };
  workspaceReads.length = 0;
  const { collectGitPayloadFiles } = await extensionModule;
  const result = await collectGitPayloadFiles([okRepo, repository] as never, ['/ws', '/x/my:repo'], [],
    { ...defaultSettings, setMaxFileCount: false }, { includeNonText: false });
  assert.deepEqual(result.files.map(f => f.path), ['b.ts']);
  assert.deepEqual(workspaceReads, ['/ws/b.ts']);
  assert.deepEqual(result.nonPortablePaths, ['my:repo/a.ts']);
});

function textChanges(n: number) {
  return Array.from({ length: n }, (_, i) => ({ uri: new Uri(`/repo/f${i}.ts`), status: 'MODIFIED' }));
}

test('SCM: the left-out count is capped, exactly the cap still reads plain, and the notice shows N+', async () => {
  const repository = { rootUri: new Uri('/repo'), state: { workingTreeChanges: textChanges(6) }, show: async () => { throw new Error('no'); } };
  const { collectGitPayloadFiles, gitNoticeCounts } = await extensionModule;
  const { copyNoticeDetails } = await import('../src/nonTextDialog.js');
  const settings = { ...defaultSettings, setMaxFileCount: true, fileCountLimit: 1 };
  const run = (leftOutCap: number) => collectGitPayloadFiles([repository] as never, ['/repo'], [], settings, { includeNonText: true, leftOutCap });

  // 5 files past the limit: cap 4 -> "4+", cap 5 -> exactly "5", cap 6 -> "5".
  const capped = await run(4);
  assert.equal(capped.limitLeftOut, 4);
  assert.equal(capped.limitLeftOutCapped, true);
  const exact = await run(5);
  assert.equal(exact.limitLeftOut, 5);
  assert.equal(exact.limitLeftOutCapped, false);
  assert.equal((await run(6)).limitLeftOutCapped, false);
  assert.deepEqual(copyNoticeDetails(gitNoticeCounts(capped)), ['Left out by the file-count limit: 4+.']);
  assert.deepEqual(copyNoticeDetails(gitNoticeCounts(exact)), ['Left out by the file-count limit: 5.']);
  // The payload never depends on the cap.
  assert.deepEqual(capped.files, exact.files);
});

test('SCM: the notice names the first unreadable paths, not a non-text file Exclude left out', async () => {
  const repository = {
    rootUri: new Uri('/repo'),
    state: { indexChanges: [
      { uri: new Uri('/repo/broken.ts'), status: 'INDEX_MODIFIED' },
      { uri: new Uri('/repo/ok.ts'), status: 'INDEX_MODIFIED' }
    ] },
    show: async (_ref: string, file: string) => {
      if (file.endsWith('broken.ts')) throw new Error('index read failed');
      return 'index:ok';
    }
  };
  const selected = ['broken.ts', 'ok.ts'].map(file => ({ uriKey: `/repo/${file}`, staged: true }));
  const { collectGitPayloadFiles, gitNoticeCounts } = await extensionModule;
  const { copyNoticeDetails } = await import('../src/nonTextDialog.js');
  const result = await collectGitPayloadFiles([repository] as never, ['/repo'], selected, defaultSettings);
  assert.deepEqual(result.unreadablePaths, ['broken.ts']);
  assert.deepEqual(copyNoticeDetails(gitNoticeCounts(result)), ['Unreadable: 1 (broken.ts).']);
});

test('X7 on SCM: a working-tree link out of every root is not read and is named Unreadable', {
  skip: process.platform === 'win32' ? 'file symlinks need privileges on Windows' : undefined
}, async () => {
  const { mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const base = await mkdtemp(path.join(os.tmpdir(), 'clipcode-scm-x7-'));
  try {
    const root = path.join(base, 'repo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(root);
    await writeFile(path.join(base, 'secret.txt'), 'token=hunter2');
    await writeFile(path.join(root, 'keep.ts'), 'keep');
    // repo/CLAUDE.md -> ../secret.txt
    await symlink(path.join(base, 'secret.txt'), path.join(root, 'CLAUDE.md'), 'file');
    const link = path.join(root, 'CLAUDE.md');
    const keep = path.join(root, 'keep.ts');
    const repository = {
      rootUri: new Uri(root),
      state: { workingTreeChanges: [
        { uri: new Uri(link), status: 'MODIFIED' },
        { uri: new Uri(keep), status: 'MODIFIED' }
      ] }
    };
    const { collectGitPayloadFiles } = await extensionModule;
    workspaceReads.length = 0;
    const result = await collectGitPayloadFiles([repository] as never, [root], [], defaultSettings);
    assert.ok(!workspaceReads.includes(link), `the link is never read (read: ${workspaceReads.join(', ')})`);
    assert.deepEqual(result.files.map(f => f.path), ['keep.ts']);
    assert.equal(result.copiedFileCount, 1);
    assert.equal(result.skippedUnreadableCount, 1);
    assert.deepEqual(result.unreadablePaths, ['CLAUDE.md']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
