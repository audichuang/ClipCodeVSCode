// SNIPCODE-HOOK: whole-file — shared `vscode` module mock for MainPanel test
// suites. Both the unit suite (MainPanel.test.ts) and the real-git integration
// suite (MainPanel.crossRepoMutation.integration.test.ts) construct the same
// panel/webview shape; keep it here so a MainPanel constructor change only has
// to be mirrored once. Usage:
//   vi.mock('vscode', async () => (await import('./vscode-mock')).makeVscodeModule(H, opts));

import { vi } from 'vitest';

export interface PanelHarness {
  messageHandler: null | ((m: unknown) => unknown);
  panel: null | { webview: { postMessage: ReturnType<typeof vi.fn> } };
}

export function makeVscodeModule(
  H: PanelHarness,
  opts: { workspaceFolders?: Array<{ uri: { fsPath: string } }> } = {},
) {
  const workspaceFolders = opts.workspaceFolders ?? [];
  const makePanel = () => {
    const panel = {
      webview: {
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (u: unknown) => u,
        postMessage: vi.fn(),
        onDidReceiveMessage: (cb: (m: unknown) => unknown) => { H.messageHandler = cb; return { dispose() {} }; },
      },
      onDidDispose: () => ({ dispose() {} }),
      reveal: vi.fn(),
      dispose: vi.fn(),
      iconPath: undefined as unknown,
      viewColumn: 1,
    };
    H.panel = panel;
    return panel;
  };
  return {
    window: {
      createWebviewPanel: vi.fn(makePanel),
      activeTextEditor: undefined,
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(async () => undefined),
      showSaveDialog: vi.fn(async () => undefined),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      getWorkspaceFolder: () => workspaceFolders[0],
      workspaceFolders,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: { writeFile: vi.fn(async () => {}) },
    },
    commands: { executeCommand: vi.fn() },
    l10n: { t: (k: string) => k },
    env: { language: 'en', clipboard: { writeText: vi.fn() } },
    Uri: {
      joinPath: () => ({}),
      file: (p: string) => ({ fsPath: p, with(o: object) { return { ...this, ...o }; } }),
      parse: () => ({ with: () => ({}) }),
    },
    ViewColumn: { One: 1 },
  };
}
