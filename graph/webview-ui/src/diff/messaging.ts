// Host <-> webview messaging for the full-tab Diff panel. Uses the shared
// memoized getVsCodeApi() (NOT a second raw acquireVsCodeApi) because
// FileDiffView -> ImageDiff also calls getVsCodeApi(), and acquireVsCodeApi()
// may be called only once per webview.
import { diffStore, type DiffSide } from './diff-store.svelte';
import { getVsCodeApi } from '../lib/vscode-api';
import { i18n } from '../lib/i18n/index.svelte';

const vscode = getVsCodeApi();

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        diffStore.setDiffs(msg.payload.repoPath, msg.payload.file, msg.payload.stagedDiff, msg.payload.unstagedDiff);
        diffStore.busy = false;
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunk' || msg.payload?.source === 'diffStageLines') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        diffStore.busy = false;
        break;
    }
  });
}

function diffFor(side: DiffSide) {
  return side === 'staged' ? diffStore.stagedDiff : diffStore.unstagedDiff;
}

/** Post a single hunk to the host; `side` decides stage vs unstage. Ignored while
 *  a prior op is still in flight (busy) — applying re-parses the diff and shifts
 *  every later hunk index, so a second click before the fresh `diffShow` lands
 *  would target the wrong hunk. Also ignored if that side currently has no diff. */
export function postStageHunk(side: DiffSide, hunkIndex: number): void {
  if (diffStore.busy) { return; }
  if (!diffFor(side)) { return; }
  diffStore.error = null;
  diffStore.busy = true;
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex },
  });
}

/** Post the gutter-selected changed lines of one hunk to the host; `side` decides
 *  stage vs unstage. Gated on `busy` for the same index-shift reason. */
export function postStageLines(side: DiffSide, hunkIndex: number, lineIndices: number[]): void {
  if (diffStore.busy) { return; }
  if (!diffFor(side)) { return; }
  diffStore.error = null;
  diffStore.busy = true;
  vscode.postMessage({
    type: 'diffStageLines',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex, lineIndices },
  });
}
