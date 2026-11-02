import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, test } from 'node:test';
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
