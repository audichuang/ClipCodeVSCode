// SNIPCODE-HOOK: whole-file — commit-box boot handshake regressions.
import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  messageHandler: null as null | ((message: unknown) => unknown),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') },
  window: { showErrorMessage: vi.fn() },
}));
vi.mock('../../panels/MainPanel', () => ({ MainPanel: { assetRootUri: {} } }));

import { CommitBoxViewProvider } from '../commit-box-view';

describe('CommitBoxViewProvider', () => {
  it('replays the staged repo count after the webview listener is ready', async () => {
    const postMessage = vi.fn();
    const workbench = {
      tree: {
        getStagedRepoCount: () => 1,
        onDidChangeTreeData: () => ({ dispose() {} }),
      },
      commit: vi.fn(),
    };
    const view = {
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage,
        onDidReceiveMessage: (handler: (message: unknown) => unknown) => { H.messageHandler = handler; },
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new CommitBoxViewProvider({} as never, workbench as never);
    provider.resolveWebviewView(view as never);
    postMessage.mockClear();

    await H.messageHandler!({ type: 'workbenchReady' });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'workbenchCommitState',
      payload: { stagedRepoCount: 1 },
    });
  });
});
