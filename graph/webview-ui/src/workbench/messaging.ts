// Host <-> webview messaging for the commit workbench, split out of workbench.ts
// so Workbench.svelte can import postCommit without a Workbench.svelte <-> entry
// circular import (entry mounts the component; the component posts messages).
import { workbenchStore } from './workbench-store.svelte';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// acquireVsCodeApi is injected by the webview host at runtime.
declare function acquireVsCodeApi(): VsCodeApi;

// Minimal one-shot vscode api (workbench has its own bundle/context; the graph
// vscode-api.ts drags in uiStore, so we acquire locally in ~3 lines).
const vscode = acquireVsCodeApi();

// Guards the commit round-trip: cleared as soon as a terminal reply (result or
// error) arrives; if the view gets disposed/reloaded mid-commit and neither
// ever arrives, this fires so Commit/Amend don't stay disabled forever (the
// squash-modal stuck-forever bug family — AGENTS.md).
const COMMIT_TIMEOUT_MS = 30_000;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

function clearCommitTimer(): void {
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
}

/* SNIPCODE-HOOK start: R6 restore an in-progress commit draft after remount */
/** Persist the draft message via the webview's own state (survives the view
 *  being hidden/remounted — see extension.ts retainContextWhenHidden). Call on
 *  every message change; cheap, and setState is a plain object write. */
export function saveDraft(message: string): void {
  vscode.setState({ message });
}
/* SNIPCODE-HOOK end */

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  /* SNIPCODE-HOOK start: R6 restore an in-progress commit draft after remount */
  const saved = vscode.getState() as { message?: string } | undefined;
  if (saved?.message) workbenchStore.message = saved.message;
  /* SNIPCODE-HOOK end */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg?.type) {
      /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
      case 'workbenchCommitState':
        workbenchStore.stagedRepoCount = Number(msg.payload?.stagedRepoCount ?? 0);
        break;
      /* SNIPCODE-HOOK end */
      case 'workbenchCommitResult':
        clearCommitTimer();
        workbenchStore.applyCommitResults(msg.payload.results);
        break;
      case 'error':
        if (msg.payload?.source === 'workbenchCommit') {
          clearCommitTimer();
          workbenchStore.committing = false;
        }
        break;
    }
  });
  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  vscode.postMessage({ type: 'workbenchReady' });
  /* SNIPCODE-HOOK end */
}

export function postCommit(amend: boolean): void {
  workbenchStore.committing = true;
  workbenchStore.commitError = null;
  clearCommitTimer();
  commitTimer = setTimeout(() => {
    commitTimer = null;
    workbenchStore.committing = false;
    workbenchStore.commitError = '提交逾時，未收到結果，請重新整理後確認狀態。';
  }, COMMIT_TIMEOUT_MS);
  vscode.postMessage({
    type: 'workbenchCommit',
    payload: { message: workbenchStore.message, amend },
  });
}
