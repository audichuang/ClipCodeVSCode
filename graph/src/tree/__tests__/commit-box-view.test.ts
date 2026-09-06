// SNIPCODE-HOOK: whole-file — commit-box boot handshake regressions.
import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  messageHandler: null as null | ((message: unknown) => unknown),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') },
  window: { showErrorMessage: vi.fn() },
  /* SNIPCODE-HOOK start: X1-5 workbench locale — same auto/env.language pattern as MainPanel/DiffPanel */
  workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
  env: { language: 'en' },
  /* SNIPCODE-HOOK end */
}));
vi.mock('../../panels/MainPanel', () => ({ MainPanel: { assetRootUri: {} } }));

import { CommitBoxViewProvider } from '../commit-box-view';

describe('CommitBoxViewProvider', () => {
  it('replays the staged repo count after the webview listener is ready', async () => {
    const postMessage = vi.fn();
    const workbench = {
      tree: {
        getStagedRepoCount: () => 1,
        getAmendTargetPushed: () => false,
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
      payload: { stagedRepoCount: 1, amendTargetPushed: false, locale: 'en' },
    });
  });

  /* SNIPCODE-HOOK start: S13 Amend prefill */
  it('replies to a prefill request with the workbench-resolved HEAD message', async () => {
    const workbench = {
      tree: {
        getStagedRepoCount: () => 1,
        getAmendTargetPushed: () => false,
        onDidChangeTreeData: () => ({ dispose() {} }),
      },
      commit: vi.fn(),
      amendPrefillMessage: vi.fn(async () => '之前的訊息'),
    };
    const postMessage = vi.fn();
    const view = {
      webview: {
        options: {}, html: '', cspSource: 'vscode-webview:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage,
        onDidReceiveMessage: (handler: (message: unknown) => unknown) => { H.messageHandler = handler; },
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new CommitBoxViewProvider({} as never, workbench as never);
    provider.resolveWebviewView(view as never);
    postMessage.mockClear();

    await H.messageHandler!({ type: 'workbenchRequestAmendPrefill' });

    expect(workbench.amendPrefillMessage).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'amendPrefill', payload: { message: '之前的訊息' } });
  });

  it('replies with a null message when amend does not have exactly one target', async () => {
    const workbench = {
      tree: {
        getStagedRepoCount: () => 2,
        getAmendTargetPushed: () => false,
        onDidChangeTreeData: () => ({ dispose() {} }),
      },
      commit: vi.fn(),
      amendPrefillMessage: vi.fn(async () => null),
    };
    const postMessage = vi.fn();
    const view = {
      webview: {
        options: {}, html: '', cspSource: 'vscode-webview:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage,
        onDidReceiveMessage: (handler: (message: unknown) => unknown) => { H.messageHandler = handler; },
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new CommitBoxViewProvider({} as never, workbench as never);
    provider.resolveWebviewView(view as never);
    postMessage.mockClear();

    await H.messageHandler!({ type: 'workbenchRequestAmendPrefill' });

    expect(postMessage).toHaveBeenCalledWith({ type: 'amendPrefill', payload: { message: null } });
  });
  /* SNIPCODE-HOOK end */
});
