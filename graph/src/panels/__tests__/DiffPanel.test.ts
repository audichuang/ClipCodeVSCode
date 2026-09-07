// SNIPCODE-HOOK: whole-file — host-side tests for the unified Staged/Unstaged
// DiffPanel. Same recipe as MainPanel.test.ts: the shared vscode mock captures
// the webview + message handler, and a fake ChangesWorkbench records routing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  messageHandler: null as null | ((m: unknown) => unknown),
  panel: null as null | { webview: { postMessage: ReturnType<typeof vi.fn> } },
  fsOpen: vi.fn(),
}));

/* shared vscode mock (see vscode-mock.ts) */
vi.mock('vscode', async () => (await import('./vscode-mock')).makeVscodeModule(H));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  H.fsOpen.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args));
  return { ...actual, open: H.fsOpen };
});
// Only DiffPanel is under test — MainPanel is imported solely for assetRootUri.
vi.mock('../MainPanel', () => ({ MainPanel: { assetRootUri: undefined } }));

import * as vscode from 'vscode';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiffPanel } from '../DiffPanel';
/* SNIPCODE-HOOK start: stale fingerprint recovery */
import { StaleDiffError } from '../../git/git-service';
/* SNIPCODE-HOOK end */
import type { ChangesWorkbench } from '../../tree/changes-workbench';
import type { StatusChange } from '../../git/git-service';

const extUri = { fsPath: '/ext' } as unknown as import('vscode').Uri;

const stagedDiff = { file: 'a.ts', hunks: [], isBinary: false, isImage: false };
const unstagedDiff = { file: 'a.ts', hunks: [], isBinary: false, isImage: false };

function makeWorkbench() {
  return {
    fileDiffData: vi.fn(async (_r: string, _f: string, side: string) =>
      side === 'staged' ? stagedDiff : unstagedDiff),
    uncommittedStatus: vi.fn(async (_r: string): Promise<{ staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }> => ({
      staged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }],
      unstaged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }],
      conflict: [],
    })),
    stageHunks: vi.fn(async () => {}),
    unstageHunks: vi.fn(async () => {}),
    stageLines: vi.fn(async () => {}),
    unstageLines: vi.fn(async () => {}),
    imageBase64: vi.fn(async () => 'QUJD'),
    fileAtRef: vi.fn(async () => ''),
    hasHead: vi.fn(async () => true),
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
  H.fsOpen.mockClear();
});

describe('DiffPanel', () => {
  /* SNIPCODE-HOOK start: perf — grammar warm reaches the FIRST file too */
  it('posts diffLoading for the file that created the panel, before its diffShow', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    const loading = posted().filter((m) => m.type === 'diffLoading');
    expect(loading).toHaveLength(1);
    expect(loading[0].payload).toEqual({ repoPath: '/r', file: 'a.ts', generation: expect.any(Number) });
    // The webview warms the grammar off this message while the host runs git,
    // so it has to precede the diff it is warming for.
    const types = posted().map((m) => m.type);
    expect(types.indexOf('diffLoading')).toBeLessThan(types.indexOf('diffShow'));
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: D6/X2 basename-only editor tab */
  it('titles the tab with the basename while the webview keeps the full path', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb); // shows /r : a.ts (root-level)
    expect((H.panel as unknown as { title: string }).title).toBe('Diff: a.ts');

    const dp2 = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    H.panel!.webview.postMessage.mockClear();
    dp2.show('/r', 'src/api/users.ts');
    await H.messageHandler!({ type: 'diffReady' });
    await flush();
    expect((H.panel as unknown as { title: string }).title).toBe('Diff: users.ts');
    expect(diffShows()[0].payload.file).toBe('src/api/users.ts');
  });
  /* SNIPCODE-HOOK end */

  it('show() fetches both sides and posts one diffShow with stagedDiff + unstagedDiff', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    /* SNIPCODE-HOOK start: live-QA-2 no oldPath argument — each side's rename
       source is resolved down in GitService, per side, from git status. */
    expect(wb.fileDiffData).toHaveBeenCalledWith('/r', 'a.ts', 'staged');
    expect(wb.fileDiffData).toHaveBeenCalledWith('/r', 'a.ts', 'unstaged');
    /* SNIPCODE-HOOK end */
    expect(diffShows()).toEqual([
      /* SNIPCODE-HOOK start: Batch B image request identity */
      { type: 'diffShow', payload: { repoPath: '/r', file: 'a.ts', generation: expect.any(Number), stagedDiff, unstagedDiff, fetchError: null } },
      /* SNIPCODE-HOOK end */
    ]);
  });

  it('a failing diff fetch posts fetchError instead of a silent empty view', async () => {
    const wb = makeWorkbench();
    wb.fileDiffData.mockRejectedValue(new Error('index.lock exists'));
    await shownPanel(wb);
    expect(diffShows()).toEqual([
      /* SNIPCODE-HOOK start: Batch B image request identity */
      { type: 'diffShow', payload: { repoPath: '/r', file: 'a.ts', generation: expect.any(Number), stagedDiff: null, unstagedDiff: null, fetchError: 'index.lock exists' } },
      /* SNIPCODE-HOOK end */
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
    (H.panel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal.mockClear();
    dp.refreshIfCurrent('/r', 'other.ts');
    dp.refreshIfCurrent('/other-repo', 'a.ts');
    await flush();
    expect(diffShows()).toHaveLength(0);
    dp.refreshIfCurrent('/r', 'a.ts');
    await flush();
    expect(diffShows()).toHaveLength(1);
    expect((H.panel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).not.toHaveBeenCalled();
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

  it('clears the old body with a loading message as soon as navigation starts', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    wb.fileDiffData.mockImplementation(async () => { await gate; return stagedDiff; });

    dp.show('/r', 'b.ts');

    expect(posted()[0]).toMatchObject({
      type: 'diffLoading', payload: { repoPath: '/r', file: 'b.ts', generation: expect.any(Number) },
    });
    release();
    await flush();
  });

  it('routes diffStageHunk by side: unstaged→stageHunks, staged→unstageHunks', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 2, fingerprint: 'unstaged-fp', operationId: 'op-1' } });
    expect(wb.stageHunks).toHaveBeenCalledWith('/r', 'a.ts', [2], 'unstaged-fp', 'op-1');
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'staged', hunkIndex: 0, fingerprint: 'staged-fp', operationId: 'op-2' } });
    expect(wb.unstageHunks).toHaveBeenCalledWith('/r', 'a.ts', [0], 'staged-fp', 'op-2');
    /* SNIPCODE-HOOK end */
  });

  it('routes diffStageLines by side with the selected line indices', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
    await H.messageHandler!({ type: 'diffStageLines', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 1, lineIndices: [0, 2], fingerprint: 'unstaged-fp', operationId: 'op-1' } });
    expect(wb.stageLines).toHaveBeenCalledWith('/r', 'a.ts', 1, [0, 2], 'unstaged-fp', 'op-1');
    await H.messageHandler!({ type: 'diffStageLines', payload: { repoPath: '/r', file: 'a.ts', side: 'staged', hunkIndex: 1, lineIndices: [1], fingerprint: 'staged-fp', operationId: 'op-2' } });
    expect(wb.unstageLines).toHaveBeenCalledWith('/r', 'a.ts', 1, [1], 'staged-fp', 'op-2');
    /* SNIPCODE-HOOK end */
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

  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  it('rejects a current stage request without a rendered diff fingerprint', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0, operationId: 'op-1' } });
    expect(wb.stageHunks).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === 'error')).toEqual([
      { type: 'error', payload: { source: 'diffStageHunk', message: 'Missing diff fingerprint — refresh before staging', operationId: 'op-1' } },
    ]);
  });
  /* SNIPCODE-HOOK end */

  it('diffOpenSide opens the native diff editor with our snipcode-diff pair for that side', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'a.ts', side: 'staged' } });
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged' } });
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/evil', file: 'a.ts', side: 'staged' } }); // dropped
    const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
    expect(calls).toHaveLength(2);
    const [stagedCall, unstagedCall] = calls as any[];
    expect(stagedCall[1].scheme).toBe('snipcode-diff');
    expect(JSON.parse(stagedCall[1].query)).toEqual({ repoPath: '/r', file: 'a.ts', ref: 'HEAD' });
    expect(JSON.parse(stagedCall[2].query).ref).toBe('');
    expect(stagedCall[3]).toBe('a.ts (Staged)');
    expect(JSON.parse(unstagedCall[1].query).ref).toBe('');
    expect(unstagedCall[2].query).toBeUndefined(); // right side is the plain working-tree file
    expect(unstagedCall[3]).toBe('a.ts (Working Tree)');
  });

  it('the registered content provider serves file content at a ref, empty when absent', async () => {
    const wb = makeWorkbench();
    wb.fileAtRef.mockResolvedValueOnce('index content');
    DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    const reg = vi.mocked(vscode.workspace.registerTextDocumentContentProvider);
    const [scheme, provider] = reg.mock.calls[reg.mock.calls.length - 1] as any[];
    expect(scheme).toBe('snipcode-diff');
    const uri = { query: JSON.stringify({ repoPath: '/r', file: 'a.ts', ref: '' }) };
    await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('index content');
    expect(wb.fileAtRef).toHaveBeenCalledWith('/r', '', 'a.ts');
    wb.fileAtRef.mockRejectedValueOnce(new Error('does not exist at HEAD'));
    await expect(provider.provideTextDocumentContent(uri)).resolves.toBe(''); // new file → empty side
    /* SNIPCODE-HOOK start: Batch B surface git content failures */
    wb.fileAtRef.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(provider.provideTextDocumentContent(uri)).rejects.toThrow('spawn failed');
    /* SNIPCODE-HOOK end */
  });

  it('invalidates index virtual documents opened before panel navigation', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    const reg = vi.mocked(vscode.workspace.registerTextDocumentContentProvider);
    const provider = reg.mock.calls[reg.mock.calls.length - 1][1] as any;
    const changed: any[] = [];
    provider.onDidChange((uri: unknown) => changed.push(uri));

    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'a.ts', side: 'staged' } });
    dp.show('/r', 'b.ts');
    await H.messageHandler!({ type: 'diffOpenSide', payload: { repoPath: '/r', file: 'b.ts', side: 'staged' } });
    (dp as unknown as { invalidateIndexDocuments(): void }).invalidateIndexDocuments();

    expect(changed.map(uri => JSON.parse(uri.query))).toEqual([
      { repoPath: '/r', file: 'a.ts', ref: '' },
      { repoPath: '/r', file: 'b.ts', ref: '' },
    ]);
  });

  it('serves getImageAtRef from git for a real ref, and empty base64 on failure', async () => {
    const wb = makeWorkbench();
    await shownPanel(wb);
    /* SNIPCODE-HOOK start: Batch B image request identity */
    const generation = diffShows()[0].payload.generation;
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: '/r', generation, ref: 'HEAD', path: 'a.ts' } });
    expect(wb.imageBase64).toHaveBeenCalledWith('/r', 'HEAD', 'a.ts');
    wb.imageBase64.mockRejectedValueOnce(new Error('bad object'));
    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: '/r', generation, ref: ':0', path: 'a.ts' } });
    expect(posted().filter((m) => m.type === 'imageData')).toEqual([
      { type: 'imageData', payload: { repoPath: '/r', generation, ref: 'HEAD', path: 'a.ts', base64: 'QUJD', mimeType: 'image/png' } },
      { type: 'imageData', payload: { repoPath: '/r', generation, ref: ':0', path: 'a.ts', base64: '', mimeType: 'image/png' } },
    ]);
    /* SNIPCODE-HOOK end */
  });

  it('deduplicates concurrent reads of the same image ref across both diff sections', async () => {
    const wb = makeWorkbench();
    let release!: (base64: string) => void;
    wb.imageBase64.mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    await shownPanel(wb);
    const generation = diffShows()[0].payload.generation;
    const request = { type: 'getImageAtRef', payload: { repoPath: '/r', generation, ref: ':0', path: 'a.ts' } };

    const first = H.messageHandler!(request);
    const second = H.messageHandler!(request);
    await flush();

    expect(wb.imageBase64).toHaveBeenCalledTimes(1);
    release('QUJD');
    await Promise.all([first, second]);
    expect(posted().filter((message) => message.type === 'imageData')).toHaveLength(1);
  });

  it('serves getImageAtRef ref:working from the working tree, dropping requests for any other file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'diffpanel-'));
    await writeFile(join(repo, 'img.png'), 'abc');
    const wb = makeWorkbench();
    const dp = DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
    dp.show(repo, 'img.png');
    await H.messageHandler!({ type: 'diffReady' });
    await flush();
    /* SNIPCODE-HOOK start: Batch B image request identity */
    const generation = diffShows()[0].payload.generation;
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: repo, generation, ref: 'working', path: 'img.png' } });
    // Not the shown file (traversal or just a different path) → dropped entirely.
    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: repo, generation, ref: 'working', path: '../escape.png' } });
    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: repo, generation, ref: 'HEAD', path: 'other.png' } });
    expect(posted().filter((m) => m.type === 'imageData')).toEqual([
      { type: 'imageData', payload: { repoPath: repo, generation, ref: 'working', path: 'img.png', base64: 'YWJj', mimeType: 'image/png' } },
    ]);
    /* SNIPCODE-HOOK end */
    expect(wb.imageBase64).not.toHaveBeenCalled();
  });

  it('bounds a working-tree image read to the 50MB cap plus one byte', async () => {
    const maxRead = 50 * 1024 * 1024 + 1;
    const read = vi.fn(async (_buffer: Buffer, _offset: number, length: number) => ({ bytesRead: length }));
    const close = vi.fn(async () => {});
    H.fsOpen.mockResolvedValueOnce({ read, close });
    const wb = makeWorkbench();
    await shownPanel(wb);
    const generation = diffShows()[0].payload.generation;

    await H.messageHandler!({ type: 'getImageAtRef', payload: { repoPath: '/r', generation, ref: 'working', path: 'a.ts' } });

    expect(H.fsOpen).toHaveBeenCalledWith('/r/a.ts', 'r');
    expect(read.mock.calls[0][2]).toBeLessThanOrEqual(64 * 1024);
    expect(Math.max(...read.mock.calls.map(call => call[2]))).toBeLessThanOrEqual(maxRead);
    expect(close).toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({ type: 'imageData', payload: { base64: '' } });
  });

  it('a stage failure after the panel is closed still notifies, without posting to the dead webview', async () => {
    const wb = makeWorkbench();
    let reject!: (e: Error) => void;
    wb.stageHunks.mockImplementationOnce(() => new Promise((_, rej) => { reject = rej; }));
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    H.panel!.webview.postMessage.mockImplementation(() => { throw new Error('Webview is disposed'); });
    const pending = H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0, fingerprint: 'rendered-fp' } });
    dp.dispose();
    reject(new Error('patch does not apply'));
    await expect(pending).resolves.toBeUndefined(); // no unhandled throw
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Stage/Unstage 失敗：patch does not apply');
    expect(H.panel!.webview.postMessage).not.toHaveBeenCalled();
  });

  /* SNIPCODE-HOOK start: stale fingerprint recovery */
  it('a stale-fingerprint failure re-pushes the fresh diff so the next click can succeed', async () => {
    const wb = makeWorkbench();
    wb.stageHunks.mockRejectedValueOnce(new StaleDiffError('stale diff; refresh before staging'));
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();

    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0, fingerprint: 'old-fp', operationId: 'op-1' } });
    await flush();

    // The error still lands (unlocks the gate)…
    expect(posted().filter((m) => m.type === 'error')).toHaveLength(1);
    // …and the panel re-pushes the CURRENT diff (fresh fingerprint), instead of
    // leaving the webview stuck re-sending the stale one forever.
    expect(diffShows()).toHaveLength(1);
  });

  it('a non-stale stage failure does not trigger a re-push', async () => {
    const wb = makeWorkbench();
    wb.stageHunks.mockRejectedValueOnce(new Error('patch does not apply'));
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0, fingerprint: 'rendered-fp', operationId: 'op-1' } });
    await flush();
    expect(diffShows()).toHaveLength(0);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
  it('a same-file tree click during a correlated refresh keeps the terminal reply correlated', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    wb.fileDiffData.mockImplementation(async () => { await gate; return stagedDiff; });

    // A successful stage kicked off its correlated refresh (op-1)…
    dp.refreshIfCurrent('/r', 'a.ts', 'op-1');
    // …and the user clicks the SAME file in the tree before it lands. The
    // superseding push must inherit op-1 — otherwise the webview (strict
    // correlation) drops the uncorrelated reply and busy sticks forever.
    dp.show('/r', 'a.ts');
    release();
    await flush();

    const shows = diffShows();
    expect(shows).toHaveLength(1); // latest-wins still holds
    expect(shows[0].payload.operationId).toBe('op-1');
  });

  it('a same-file show after the correlated refresh landed stays uncorrelated', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    dp.refreshIfCurrent('/r', 'a.ts', 'op-1');
    await flush(); // op-1 refresh posts its correlated diffShow
    H.panel!.webview.postMessage.mockClear();

    dp.show('/r', 'a.ts');
    await flush();

    // The op is settled; a later same-file push must NOT resurrect its id
    // (the webview would drop a correlated diffShow for a cleared op).
    expect(diffShows()).toHaveLength(1);
    expect(diffShows()[0].payload.operationId).toBeUndefined();
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: loading state only on navigation */
  it('a same-file refresh keeps the body instead of flashing the loading state', async () => {
    const wb = makeWorkbench();
    const dp = await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();

    dp.refreshIfCurrent('/r', 'a.ts');
    await flush();

    expect(posted().filter((m) => m.type === 'diffLoading')).toHaveLength(0);
    expect(diffShows()).toHaveLength(1);
  });
  /* SNIPCODE-HOOK end */

  it('a failing stage op posts a matching error back to the webview', async () => {
    const wb = makeWorkbench();
    wb.stageHunks.mockRejectedValueOnce(new Error('patch does not apply'));
    await shownPanel(wb);
    H.panel!.webview.postMessage.mockClear();
    /* SNIPCODE-HOOK start: Batch B stage operation correlation */
    await H.messageHandler!({ type: 'diffStageHunk', payload: { repoPath: '/r', file: 'a.ts', side: 'unstaged', hunkIndex: 0, fingerprint: 'rendered-fp', operationId: 'op-1' } });
    const errors = posted().filter((m) => m.type === 'error');
    expect(errors).toEqual([
      { type: 'error', payload: { source: 'diffStageHunk', message: 'patch does not apply', operationId: 'op-1' } },
    ]);
    /* SNIPCODE-HOOK end */
  });

  describe('openNativeDiff and Jump to Source', () => {
    it('resolves oldPath independently per side on a staged rename with unstaged modifications', async () => {
      const wb = makeWorkbench();
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [{ path: 'new.ts', oldPath: 'old.ts', status: 'R' }],
        unstaged: [{ path: 'new.ts', status: 'M' }],
        conflict: [],
      });
      const dp = await shownPanel(wb);

      // Staged side: left should be old.ts at HEAD, right should be new.ts at index
      await dp.openNativeDiff('/r', 'new.ts', 'staged');
      let calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      const stagedCall = calls[calls.length - 1] as any[];
      expect(JSON.parse(stagedCall[1].query)).toEqual({ repoPath: '/r', file: 'old.ts', ref: 'HEAD' });
      expect(JSON.parse(stagedCall[2].query)).toEqual({ repoPath: '/r', file: 'new.ts', ref: '' });
      expect(stagedCall[3]).toBe('new.ts (Staged)');

      // Unstaged side: left should be new.ts at index, right should be new.ts working tree file
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [{ path: 'new.ts', oldPath: 'old.ts', status: 'R' }],
        unstaged: [{ path: 'new.ts', status: 'M' }],
        conflict: [],
      });
      await dp.openNativeDiff('/r', 'new.ts', 'unstaged');
      calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      const unstagedCall = calls[calls.length - 1] as any[];
      expect(JSON.parse(unstagedCall[1].query)).toEqual({ repoPath: '/r', file: 'new.ts', ref: '' });
      expect(unstagedCall[2].query).toBeUndefined(); // working tree fileUri
      expect(unstagedCall[2].fsPath).toBe('/r/new.ts');
      expect(unstagedCall[3]).toBe('new.ts (Working Tree)');
    });

    it('uses virtual empty document when file is deleted in working tree', async () => {
      const wb = makeWorkbench();
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [],
        unstaged: [{ path: 'deleted.ts', status: 'D' }],
        conflict: [],
      });
      const dp = await shownPanel(wb);

      await dp.openNativeDiff('/r', 'deleted.ts', 'unstaged');
      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      const call = calls[calls.length - 1] as any[];
      expect(JSON.parse(call[2].query)).toEqual({ repoPath: '/r', file: 'deleted.ts', ref: 'empty' });
      expect(call[3]).toBe('deleted.ts (Working Tree)');
    });

    it('clamps requested line to document lineCount and sets selection Range', async () => {
      const wb = makeWorkbench();
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [],
        unstaged: [{ path: 'a.ts', status: 'M' }],
        conflict: [],
      });
      const dp = await shownPanel(wb);

      // doc lineCount is mocked as 100 in vscode-mock
      await dp.openNativeDiff('/r', 'a.ts', 'unstaged', 250);
      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      const call = calls[calls.length - 1] as any[];
      const options = call[4];
      expect(options.selection).toBeDefined();
      expect(options.selection.start.line).toBe(99); // 100 clamped (0-indexed 99)
    });

    it('handles diffJumpToEditor message from webview with generation check', async () => {
      const wb = makeWorkbench();
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [],
        unstaged: [{ path: 'a.ts', status: 'M' }],
        conflict: [],
      });
      const dp = await shownPanel(wb);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Stale generation is ignored
      const gen = (dp as any).current.generation;
      await H.messageHandler!({
        type: 'diffJumpToEditor',
        payload: { repoPath: '/r', file: 'a.ts', generation: gen + 999, line: 42 },
      });
      let calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(0);

      // Matching generation triggers openNativeDiff
      await H.messageHandler!({
        type: 'diffJumpToEditor',
        payload: { repoPath: '/r', file: 'a.ts', generation: gen, line: 42 },
      });
      calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(1);
      expect(calls[0][4].selection.start.line).toBe(41); // line 42 (0-indexed 41)
    });

    it('jumpCurrentToSource asks webview to request jump with active line', async () => {
      const wb = makeWorkbench();
      const dp = await shownPanel(wb);
      H.panel!.webview.postMessage.mockClear();

      dp.jumpCurrentToSource();
      const messages = posted();
      expect(messages).toEqual([{ type: 'requestJumpToSource' }]);
    });

    it('content provider returns empty string for brand new repo without commits', async () => {
      const wb = makeWorkbench();
      DiffPanel.register(extUri, wb as unknown as ChangesWorkbench);
      const reg = vi.mocked(vscode.workspace.registerTextDocumentContentProvider);
      const provider = reg.mock.calls[reg.mock.calls.length - 1][1] as any;

      wb.hasHead.mockResolvedValueOnce(false);
      const uri = { query: JSON.stringify({ repoPath: '/r', file: 'a.ts', ref: 'HEAD' }) };
      await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('');

      // When hasHead returns true but git emits invalid object name 'HEAD'.
      wb.hasHead.mockResolvedValueOnce(true);
      wb.fileAtRef.mockRejectedValueOnce(new Error("fatal: invalid object name 'HEAD'."));
      await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('');

      // empty ref returns empty string directly without calling fileAtRef
      const emptyUri = { query: JSON.stringify({ repoPath: '/r', file: 'a.ts', ref: 'empty' }) };
      await expect(provider.provideTextDocumentContent(emptyUri)).resolves.toBe('');
    });

    it('opens native diff for first staged file in unborn repo using virtual empty document on the left', async () => {
      const wb = makeWorkbench();
      wb.hasHead.mockResolvedValue(false);
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [{ path: 'review.txt', status: 'A' }],
        unstaged: [],
        conflict: [],
      });
      const dp = await shownPanel(wb);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      await dp.openNativeDiff('/r', 'review.txt', 'staged');
      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(1);
      const [_, leftUri, rightUri, title] = calls[0] as any[];
      // In unborn repo, left side must be empty virtual doc, NOT HEAD
      expect(JSON.parse(leftUri.query)).toEqual({ repoPath: '/r', file: 'review.txt', ref: 'empty' });
      expect(JSON.parse(rightUri.query)).toEqual({ repoPath: '/r', file: 'review.txt', ref: '' });
      expect(title).toBe('review.txt (Staged)');
    });

    it('falls back to staged comparison when jumping to source of a staged-only deletion', async () => {
      const wb = makeWorkbench();
      wb.uncommittedStatus.mockResolvedValueOnce({
        staged: [{ path: 'deleted.txt', status: 'D' }],
        unstaged: [],
        conflict: [],
      });
      const dp = await shownPanel(wb);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Even if webview requested unstaged, staged-only deletion must open staged comparison
      await dp.openNativeDiff('/r', 'deleted.txt', 'unstaged');
      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(1);
      const [_, leftUri, rightUri, title] = calls[0] as any[];
      expect(JSON.parse(leftUri.query)).toEqual({ repoPath: '/r', file: 'deleted.txt', ref: 'HEAD' });
      expect(JSON.parse(rightUri.query)).toEqual({ repoPath: '/r', file: 'deleted.txt', ref: '' });
      expect(title).toBe('deleted.txt (Staged)');
    });

    it('prevents delayed native diff open request from reclaiming editor after navigation', async () => {
      const wb = makeWorkbench();
      let resolveStatusA: (v: { staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }) => void;
      const statusAPromise = new Promise<{ staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }>((resolve) => { resolveStatusA = resolve; });

      wb.uncommittedStatus.mockImplementation(async (repoPath: string) => {
        if (repoPath === '/repoA') {
          return statusAPromise;
        }
        return { staged: [], unstaged: [{ path: 'b.ts', status: 'M' }], conflict: [] };
      });

      const dp = await shownPanel(wb);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Trigger open for A (which will hang on statusAPromise)
      const openAPromise = dp.openNativeDiff('/repoA', 'a.ts', 'unstaged');

      // User navigates panel to B
      dp.show('/repoB', 'b.ts');

      // Now release A's status
      resolveStatusA!({ staged: [], unstaged: [{ path: 'a.ts', status: 'M' }], conflict: [] });
      await openAPromise;

      // vscode.diff should NOT have been called for A
      const callsA = vi.mocked(vscode.commands.executeCommand).mock.calls
        .filter((c) => c[0] === 'vscode.diff' && String(c[3]).includes('a.ts'));
      expect(callsA).toHaveLength(0);
    });

    it('prevents delayed native diff open request after panel is disposed', async () => {
      const wb = makeWorkbench();
      let resolveStatusA: (v: { staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }) => void;
      const statusAPromise = new Promise<{ staged: StatusChange[]; unstaged: StatusChange[]; conflict: StatusChange[] }>((resolve) => { resolveStatusA = resolve; });

      wb.uncommittedStatus.mockImplementation(async (repoPath: string) => {
        if (repoPath === '/repoA') {
          return statusAPromise;
        }
        return { staged: [], unstaged: [{ path: 'b.ts', status: 'M' }], conflict: [] };
      });

      const dp = await shownPanel(wb);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Trigger open for A (which will hang on statusAPromise)
      const openAPromise = dp.openNativeDiff('/repoA', 'a.ts', 'unstaged');

      // User closes / disposes the panel
      dp.dispose();

      // Now release A's status
      resolveStatusA!({ staged: [], unstaged: [{ path: 'a.ts', status: 'M' }], conflict: [] });
      await openAPromise;

      // vscode.diff should NOT have been called
      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(0);
    });

    it('opens native diff directly from sidebar without webview created', async () => {
      const wb = makeWorkbench();
      const dp = DiffPanel.register(extUri, wb as any);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      await dp.openNativeDiff('/r', 'a.ts', 'unstaged');

      const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter((c) => c[0] === 'vscode.diff');
      expect(calls).toHaveLength(1);
      const [_, leftUri, rightUri, title] = calls[0] as any[];
      expect(JSON.parse(leftUri.query)).toEqual({ repoPath: '/r', file: 'a.ts', ref: '' });
      expect(rightUri.fsPath).toBe('/r/a.ts');
      expect(title).toBe('a.ts (Working Tree)');
    });
  });
});
