// Host <-> webview messaging for the full-tab Diff panel. Uses the shared
// memoized getVsCodeApi() (NOT a second raw acquireVsCodeApi) because
// FileDiffView -> ImageDiff also calls getVsCodeApi(), and acquireVsCodeApi()
// may be called only once per webview.
import { diffStore, type DiffSide } from './diff-store.svelte';
import { getVsCodeApi } from '../lib/vscode-api';
import { i18n, t } from '../lib/i18n/index.svelte';

const vscode = getVsCodeApi();

/** Bound the stage round-trip (AGENTS.md: request→response waits MUST carry a
 *  timeout) with FEEDBACK, not an unlock: past this deadline a banner tells the
 *  user what's stuck, but `busy` stays true — the op may still be running
 *  host-side (a >15s refresh on a huge repo), and unlocking would let a second
 *  click stage against stale hunk indices, hitting the wrong hunk. The eventual
 *  `diffShow`/`error` unlocks; if the reply is truly lost, reopening the Diff
 *  tab re-handshakes and re-pushes. */
const STAGE_TIMEOUT_MS = 15_000;
let stageTimer: ReturnType<typeof setTimeout> | undefined;
/* SNIPCODE-HOOK start: Batch B stage operation correlation */
let nextOperationId = 0;
/* SNIPCODE-HOOK end */

function clearStageTimeout(): void {
  clearTimeout(stageTimer);
  stageTimer = undefined;
}

/** Wire the extension -> webview message handler. Safe to call more than once —
 *  only the first call registers (repeat calls in tests must not stack handlers). */
let listening = false;
export function listenForHostMessages(): void {
  if (listening) { return; }
  listening = true;
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
      case 'diffLoading':
        if (msg.payload.operationId !== undefined && msg.payload.operationId !== diffStore.operationId) break;
        diffStore.beginLoad(
          String(msg.payload.repoPath),
          String(msg.payload.file),
          Number(msg.payload.generation ?? 0),
          msg.payload.operationId === undefined ? undefined : String(msg.payload.operationId),
        );
        break;
      /* SNIPCODE-HOOK end */
      case 'diffShow':
        /* SNIPCODE-HOOK start: Batch B stage operation correlation */
        if (msg.payload.operationId !== undefined && msg.payload.operationId !== diffStore.operationId) break;
        /* SNIPCODE-HOOK end */
        clearStageTimeout();
        // setDiffs also clears busy/error — the fresh push unlocks the buttons.
        /* SNIPCODE-HOOK start: Batch B image request identity */
        diffStore.setDiffs(msg.payload.repoPath, msg.payload.file, msg.payload.stagedDiff, msg.payload.unstagedDiff, Number(msg.payload.generation ?? 0));
        /* SNIPCODE-HOOK end */
        // A failed fetch arrives as null sides + fetchError; showing it stops the
        // empty state from reading as an affirmative "No changes".
        if (msg.payload.fetchError) { diffStore.error = String(msg.payload.fetchError); }
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        /* SNIPCODE-HOOK start: Batch B stage operation correlation */
        if (msg.payload?.operationId !== undefined && msg.payload.operationId !== diffStore.operationId) break;
        if (msg.payload?.operationId === undefined && diffStore.operationId !== null) break;
        /* SNIPCODE-HOOK end */
        clearStageTimeout();
        if (msg.payload?.source === 'diffStageHunk' || msg.payload?.source === 'diffStageLines') {
          diffStore.error = String(msg.payload.message ?? t('file.stageFailed'));
        }
        diffStore.busy = false;
        /* SNIPCODE-HOOK start: Batch B stage operation correlation */
        diffStore.operationId = null;
        /* SNIPCODE-HOOK end */
        break;
    }
  });
}

function diffFor(side: DiffSide) {
  return side === 'staged' ? diffStore.stagedDiff : diffStore.unstagedDiff;
}

/** Shared gate for both stage ops. Refuses while a prior op is in flight (busy) —
 *  applying re-parses the diff and shifts every later hunk/line index, so a second
 *  click before the fresh `diffShow` lands would target the wrong hunk — and when
 *  the requested side has no diff. On success flags busy and arms the timeout. */
/* SNIPCODE-HOOK start: Batch B stage operation correlation */
function beginStageOp(side: DiffSide): string | null {
  if (diffStore.busy) { return null; }
  if (!diffFor(side)?.fingerprint) { return null; }
  diffStore.error = null;
  diffStore.busy = true;
  const operationId = `diff-${++nextOperationId}`;
  diffStore.operationId = operationId;
  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => {
    stageTimer = undefined;
    diffStore.error = t('file.stageTimeout');
  }, STAGE_TIMEOUT_MS);
  return operationId;
}
/* SNIPCODE-HOOK end */

/** Ask the host to open this side's FULL-FILE diff in a native editor tab
 *  (staged: HEAD↔index, unstaged: index↔working). Read-only — no busy gate. */
export function postOpenSide(side: DiffSide): void {
  if (!diffFor(side)) { return; }
  vscode.postMessage({
    type: 'diffOpenSide',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side },
  });
}

/** Post a single hunk to the host; `side` decides stage vs unstage. */
export function postStageHunk(side: DiffSide, hunkIndex: number): void {
  /* SNIPCODE-HOOK start: Batch B stage operation correlation */
  const operationId = beginStageOp(side);
  if (!operationId) { return; }
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  const fingerprint = diffFor(side)?.fingerprint;
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex, operationId, ...(fingerprint ? { fingerprint } : {}) },
  });
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */
}

/** Post the gutter-selected changed lines of one hunk to the host; `side` decides
 *  stage vs unstage. */
export function postStageLines(side: DiffSide, hunkIndex: number, lineIndices: number[]): void {
  /* SNIPCODE-HOOK start: Batch B stage operation correlation */
  const operationId = beginStageOp(side);
  if (!operationId) { return; }
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  const fingerprint = diffFor(side)?.fingerprint;
  vscode.postMessage({
    type: 'diffStageLines',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex, lineIndices, operationId, ...(fingerprint ? { fingerprint } : {}) },
  });
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */
}
