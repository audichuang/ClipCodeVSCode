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
      { type: 'diffShow', payload: { repoPath: '/r', file: 'a.ts', stagedDiff, unstagedDiff } },
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
