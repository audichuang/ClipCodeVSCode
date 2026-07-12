// Host <-> webview messaging for the full-tab Diff panel. Uses the shared
// memoized getVsCodeApi() (NOT a second raw acquireVsCodeApi) because
// FileDiffView -> ImageDiff also calls getVsCodeApi(), and acquireVsCodeApi()
// may be called only once per webview.
import { diffStore } from './diff-store.svelte';
import { getVsCodeApi } from '../lib/vscode-api';
import { i18n } from '../lib/i18n/index.svelte';

const vscode = getVsCodeApi();

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        diffStore.setDiff(msg.payload.repoPath, msg.payload.file, msg.payload.side, msg.payload.diff);
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunk') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        break;
    }
  });
}

/** Post a single hunk to the host; side decides stage vs unstage. */
export function postStageHunk(hunkIndex: number): void {
  if (!diffStore.diff) { return; }
  diffStore.error = null;
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: {
      repoPath: diffStore.repoPath,
      file: diffStore.file,
      side: diffStore.side,
      hunkIndex,
    },
  });
}
