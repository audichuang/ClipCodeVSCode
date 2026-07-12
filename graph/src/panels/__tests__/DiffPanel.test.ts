// SNIPCODE-HOOK: whole-file — host-side tests for the unified Staged/Unstaged
// DiffPanel. Same recipe as MainPanel.test.ts: the shared vscode mock captures
// the webview + message handler, and a fake ChangesWorkbench records routing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  messageHandler: null as null | ((m: unknown) => unknown),
  panel: null as null | { webview: { postMessage: ReturnType<typeof vi.fn> } },
}));

/* shared vscode mock (see vscode-mock.ts) */
vi.mock('vscode', async () => (await import('./vscode-mock')).makeVscodeModule(H));
// Only DiffPanel is under test — MainPanel is imported solely for assetRootUri.
vi.mock('../MainPanel', () => ({ MainPanel: { assetRootUri: undefined } }));

import * as vscode from 'vscode';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiffPanel } from '../DiffPanel';
import type { ChangesWorkbench } from '../../tree/changes-workbench';

const extUri = { fsPath: '/ext' } as unknown as import('vscode').Uri;

const stagedDiff = { file: 'a.ts', hunks: [], isBinary: false, isImage: false };
const unstagedDiff = { file: 'a.ts', hunks: [], isBinary: false, isImage: false };

function makeWorkbench() {
  return {
    fileDiffData: vi.fn(async (_r: string, _f: string, side: string) =>
      side === 'staged' ? stagedDiff : unstagedDiff),
    stageHunks: vi.fn(async () => {}),
    unstageHunks: vi.fn(async () => {}),
    stageLines: vi.fn(async () => {}),
    unstageLines: vi.fn(async () => {}),
    imageBase64: vi.fn(async () => 'QUJD'),
  };
}
type Workbench = ReturnType<typeof makeWorkbench>;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Boot a panel to the post-handshake state showing /r:a.ts. */
async function shownPanel(wb: Workbench) {
  const dp = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
  dp.show('/r', 'a.ts');
  await H.messageHandler!({ type: 'diffReady' });
  await flush();
  return dp;
}

const posted = () => H.panel!.webview.postMessage.mock.calls.map((c) => c[0]);
const diffShows = () => posted().filter((m) => m.type === 'diffShow');

beforeEach(() => {
  H.messageHandler = null;
  H.panel = null;
});

describe('DiffPanel', () => {
  it('show() fetches both sides and posts one diffShow with stagedDiff + unstagedDiff', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    expect(wb.fileDiffData).toHaveBeenCalledWith('/r', 'a.ts', 'staged');
    expect(wb.fileDiffData).toHaveBeenCalledWith('/r', 'a.ts', 'unstaged');
    expect(diffShows()).toEqual([
      { type: 'diffShow', payload: { repoPath: '/r', file: 'a.ts', stagedDiff, unstagedDiff, fetchError: null } },
    ]);
  });

  it('a failing diff fetch posts fetchError instead of a silent empty view', async () => {
    const wb = makeWorkbench();
    wb.fileDiffData.mockRejectedValue(new Error('index.lock exists'));
    await shownPanel(wb);
    expect(diffShows()).toEqual([
      { type: 'diffShow', payload: { repoPath: '/r', file: 'a.ts', stagedDiff: null, unstagedDiff: null, fetchError: 'index.lock exists' } },
    ]);
  });

  it('does not push before the diffReady handshake', async () => {
    const wb = makeWorkbench();
    const dp = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    dp.show('/r', 'a.ts');
    await flush();
    expect(wb.fileDiffData).not.toHaveBeenCalled();
  });

  it('refreshIfCurrent re-pushes only for the file still shown', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    dp.refreshIfCurrent('/r', 'other.ts');
    dp.refreshIfCurrent('/other-repo', 'a.ts');
    await flush();
    expect(diffShows()).toHaveLength(0);
    dp.refreshIfCurrent('/r', 'a.ts');
    await flush();
    expect(diffShows()).toHaveLength(1);
  });

  it('a slower older push never overwrites a newer one (latest-wins ticket)', async () => {
    const wb = makeWorkbench();
    let releaseOld!: () => void;
    const gate = new Promise<void>((r) => { releaseOld = r; });
    wb.fileDiffData
      .mockImplementationOnce(async () => { await gate; return stagedDiff; }) // a.ts staged (slow)
      .mockImplementationOnce(async () => unstagedDiff);                       // a.ts unstaged
    const dp = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    dp.show('/r', 'a.ts');
    await H.messageHandler!({ type: 'diffReady' });
    dp.show('/r', 'b.ts');
    await flush();
    releaseOld();
    await flush();
    const files = diffShows().map((m) => m.payload.file);
    expect(files).toEqual(['b.ts']); // the superseded a.ts push was dropped
  });

  it('routes diffStageHunk by side: unstaged→stageHunks, staged→unstageHunks', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 2 } });
    expect(wb.stageHunks).toHaveBeenCalledWith('/r', 'a.ts', [2]);
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'staged', hunkIndex: 0 } });
    expect(wb.unstageHunks).toHaveBeenCalledWith('/r', 'a.ts', [0]);
  });

  it('routes diffStageLines by side with the selected line indices', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    await H.messageHandler!({ type: 'diffStageLines', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 1, lineIndices: [0, 2] } });
    expect(wb.stageLines).toHaveBeenCalledWith('/r', 'a.ts', 1, [0, 2]);
    await H.messageHandler!({ type: 'diffStageLines', payload: { repoPath: '/r', file: 'a.ts', side: 'staged', hunkIndex: 1, lineIndices: [1] } });
    expect(wb.unstageLines).toHaveBeenCalledWith('/r', 'a.ts', 1, [1]);
  });

  it('rejects a stage request whose repoPath/file is not the shown file', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: '../../etc/passwd', side: 'unstaged', hunkIndex: 0 } });
    await H.messageHandler!({ type: 'diffStageLines', payload: { repoPath: '/evil', file: 'a.ts', side: 'unstaged', hunkIndex: 0, lineIndices: [0] } });
    expect(wb.stageHunks).not.toHaveBeenCalled();
    expect(wb.stageLines).not.toHaveBeenCalled();
    const errors = posted().filter((m) => m.type === 'error');
    expect(errors.map((m) => m.payload.source)).toEqual(['diffStageHunk', 'diffStageLines']);
  });

  it('diffOpenSide opens the native diff editor with the git-scheme pair for that side', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'a.ts', side: 'staged' } });
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged' } });
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/evil', file: 'a.ts', side: 'staged' } }); // dropped
    const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
    expect(calls).toHaveLength(2);
    const [stagedCall, unstagedCall] = calls as any[];
    expect(JSON.parse(stagedCall[1].query).ref).toBe('HEAD');
    expect(JSON.parse(stagedCall[2].query).ref).toBe('');
    expect(stagedCall[3]).toBe('a.ts (Staged)');
    expect(JSON.parse(unstagedCall[1].query).ref).toBe('');
    expect(unstagedCall[2].query).toBeUndefined(); // right side is the plain working-tree file
    expect(unstagedCall[3]).toBe('a.ts (Working Tree)');
  });

  it('serves getImageAtRef from git for a real ref, and empty base64 on failure', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'getImageAtRef', payload: { ref: 'HEAD', path: 'a.ts' } });
    expect(wb.imageBase64).toHaveBeenCalledWith('/r', 'HEAD', 'a.ts');
    wb.imageBase64.mockRejectedValueOnce(new Error('bad object'));
    await H.messageHandler!({ type: 'getImageAtRef', payload: { ref: ':0', path: 'a.ts' } });
    expect(posted().filter((m) => m.type === 'imageData')).toEqual([
      { type: 'imageData', payload: { ref: 'HEAD', path: 'a.ts', base64: 'QUJD', mimeType: 'image/png' } },
      { type: 'imageData', payload: { ref: ':0', path: 'a.ts', base64: '', mimeType: 'image/png' } },
    ]);
  });

  it('serves getImageAtRef ref:working from the working tree, dropping requests for any other file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'diffpanel-'));
    await writeFile(join(repo, 'img.png'), 'abc');
    const wb = makeWorkbench();
    const dp = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    dp.show(repo, 'img.png');
    await H.messageHandler!({ type: 'diffReady' });
    await flush();
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'getImageAtRef', payload: { ref: 'working', path: 'img.png' } });
    // Not the shown file (traversal or just a different path) → dropped entirely.
    await H.messageHandler!({ type: 'getImageAtRef', payload: { ref: 'working', path: '../escape.png' } });
    await H.messageHandler!({ type: 'getImageAtRef', payload: { ref: 'HEAD', path: 'other.png' } });
    expect(posted().filter((m) => m.type === 'imageData')).toEqual([
      { type: 'imageData', payload: { ref: 'working', path: 'img.png', base64: 'YWJj', mimeType: 'image/png' } },
    ]);
    expect(wb.imageBase64).not.toHaveBeenCalled();
  });

  it('a stage failure after the panel is closed still notifies, without posting to the dead webview', async () => {
    const wb = makeWorkbench();
    let reject!: (e: Error) => void;
    wb.stageHunks.mockImplementationOnce(() => new Promise((_, rej) => { reject = rej; }));
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    H.panel!.webview.postMessage.mockImplementation(() => { throw new Error('Webview is disposed'); });
    const pending = H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0 } });
    dp.dispose();
    reject(new Error('patch does not apply'));
    await expect(pending).resolves.toBeUndefined(); // no unhandled throw
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Stage/Unstage 失敗：patch does not apply');
    expect(H.panel!.webview.postMessage).not.toHaveBeenCalled();
  });

  it('a failing stage op posts a matching error back to the webview', async () => {
    const wb = makeWorkbench();
    wb.stageHunks.mockRejectedValueOnce(new Error('patch does not apply'));
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0 } });
    const errors = posted().filter((m) => m.type === 'error');
    expect(errors).toEqual([
      { type: 'error', payload: { source: 'diffStageHunk', message: 'patch does not apply' } },
    ]);
  });
});
