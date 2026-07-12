// Host <-> webview messaging for the Diff view, split out of diff.ts so
// Diff.svelte can import postStageHunks without a circular entry import.
// Mirrors workbench/messaging.ts: this bundle has its own vscode api context.
import { diffStore } from './diff-store.svelte';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Bound wait so a disposed/reloaded view mid-apply doesn't leave the button
// stuck disabled forever (the squash-modal stuck-forever bug family — AGENTS.md).
const APPLY_TIMEOUT_MS = 30_000;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

function clearApplyTimer(): void {
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
}

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        // A fresh diff arrived (initial click OR a re-render after apply) — the
        // apply round-trip, if any, is done.
        clearApplyTimer();
        diffStore.setDiff(msg.payload.repoPath, msg.payload.file, msg.payload.side, msg.payload.hunks);
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunks') {
          clearApplyTimer();
          diffStore.busy = false;
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        break;
    }
  });
}

/** Post the checked hunks to the host; side decides stage vs unstage. */
export function postStageHunks(): void {
  if (!diffStore.canApply) { return; }
  diffStore.busy = true;
  diffStore.error = null;
  clearApplyTimer();
  applyTimer = setTimeout(() => {
    applyTimer = null;
    diffStore.busy = false;
    diffStore.error = '操作逾時，未收到結果，請重新整理後確認狀態。';
  }, APPLY_TIMEOUT_MS);
  vscode.postMessage({
    type: 'diffStageHunks',
    payload: {
      repoPath: diffStore.repoPath,
      file: diffStore.file,
      side: diffStore.side,
      hunkIndices: diffStore.selectedIndices, // already a plain number[]
    },
  });
}
