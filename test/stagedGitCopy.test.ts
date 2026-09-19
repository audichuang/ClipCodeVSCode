import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, test } from 'node:test';
import { defaultSettings } from '../src/settings.js';

class Uri {
  constructor(readonly fsPath: string) {}
}

const workspaceReads: string[] = [];
const vscode = {
  Uri,
  workspace: {
    fs: {
      readFile: async (uri: Uri) => {
        workspaceReads.push(uri.fsPath);
        return new TextEncoder().encode(`working:${uri.fsPath}`);
      },
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
