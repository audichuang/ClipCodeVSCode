// Host <-> webview messaging for the commit workbench, split out of workbench.ts
// so Workbench.svelte can import postCommit without a Workbench.svelte <-> entry
// circular import (entry mounts the component; the component posts messages).
import { workbenchStore } from './workbench-store.svelte';
/* SNIPCODE-HOOK start: X1-5 workbench locale (reuses the graph i18n dictionaries) */
import { i18n, t } from '../lib/i18n/index.svelte';
/* SNIPCODE-HOOK end */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// acquireVsCodeApi is injected by the webview host at runtime.
declare function acquireVsCodeApi(): VsCodeApi;

// Minimal one-shot vscode api (workbench has its own bundle/context; the graph
// vscode-api.ts drags in uiStore, so we acquire locally in ~3 lines).
let vscode: VsCodeApi | undefined;
function vscodeApi(): VsCodeApi {
  return vscode ??= acquireVsCodeApi();
}

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
  vscodeApi().setState({ message });
}
/* SNIPCODE-HOOK end */

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  /* SNIPCODE-HOOK start: R6 restore an in-progress commit draft after remount */
  const saved = vscodeApi().getState() as { message?: string } | undefined;
  if (saved?.message) workbenchStore.message = saved.message;
  /* SNIPCODE-HOOK end */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg?.type) {
      /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
      case 'workbenchCommitState':
        workbenchStore.stagedRepoCount = Number(msg.payload?.stagedRepoCount ?? 0);
        workbenchStore.stagedFileCount = Number(msg.payload?.stagedFileCount ?? 0);
        workbenchStore.commitScopeReady = Boolean(msg.payload?.commitScopeReady);
        /* SNIPCODE-HOOK start: S13 "already pushed" warning for Amend */
        workbenchStore.amendTargetPushed = Boolean(msg.payload?.amendTargetPushed);
        /* SNIPCODE-HOOK end */
        /* SNIPCODE-HOOK start: X1-5 workbench locale rides the existing boot/refresh message */
        if (typeof msg.payload?.locale === 'string') i18n.setLocale(msg.payload.locale);
        /* SNIPCODE-HOOK end */
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
      /* SNIPCODE-HOOK start: S13 Amend prefill */
      case 'amendPrefill': {
        const prefill = msg.payload?.message;
        if (typeof prefill === 'string' && prefill.trim() !== '') workbenchStore.message = prefill;
        break;
      }
      /* SNIPCODE-HOOK end */
    }
  });
  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  vscodeApi().postMessage({ type: 'workbenchReady' });
  /* SNIPCODE-HOOK end */
}

export function postCommit(amend: boolean): void {
  workbenchStore.committing = true;
  workbenchStore.commitError = null;
  clearCommitTimer();
  commitTimer = setTimeout(() => {
    commitTimer = null;
    workbenchStore.committing = false;
    /* SNIPCODE-HOOK start: X1-5 workbench string through webview i18n */
    workbenchStore.commitError = t('workbench.commitTimeout');
    /* SNIPCODE-HOOK end */
  }, COMMIT_TIMEOUT_MS);
  vscodeApi().postMessage({
    type: 'workbenchCommit',
    payload: { message: workbenchStore.message, amend },
  });
}

/* SNIPCODE-HOOK start: S13 Amend prefill */
/** Ask the host for HEAD's message of the single Amend target repo, so an
 *  empty textarea gets filled instead of Amend silently doing nothing. */
export function requestAmendPrefill(): void {
  vscodeApi().postMessage({ type: 'workbenchRequestAmendPrefill' });
}
/* SNIPCODE-HOOK end */
