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

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg?.type) {
      case 'workbenchStatus':
        workbenchStore.setStatus(msg.payload);
        break;
      case 'workbenchCommitResult':
        workbenchStore.applyCommitResults(msg.payload.results);
        break;
      case 'error':
        if (msg.payload?.source === 'workbenchCommit') workbenchStore.committing = false;
        break;
    }
  });
}

export function postCommit(amend: boolean): void {
  workbenchStore.committing = true;
  vscode.postMessage({
    type: 'workbenchCommit',
    payload: {
      message: workbenchStore.message,
      amend,
      // $state proxies must be snapshotted before postMessage (DataCloneError).
      repos: JSON.parse(JSON.stringify(workbenchStore.selections())),
    },
  });
}

export function requestStatus(): void {
  vscode.postMessage({ type: 'workbenchGetStatus' });
}
