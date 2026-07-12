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
      case 'diffShow':
        clearStageTimeout();
        // setDiffs also clears busy/error — the fresh push unlocks the buttons.
        diffStore.setDiffs(msg.payload.repoPath, msg.payload.file, msg.payload.stagedDiff, msg.payload.unstagedDiff);
        // A failed fetch arrives as null sides + fetchError; showing it stops the
        // empty state from reading as an affirmative "No changes".
        if (msg.payload.fetchError) { diffStore.error = String(msg.payload.fetchError); }
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        clearStageTimeout();
        if (msg.payload?.source === 'diffStageHunk' || msg.payload?.source === 'diffStageLines') {
          diffStore.error = String(msg.payload.message ?? t('file.stageFailed'));
        }
        diffStore.busy = false;
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
function beginStageOp(side: DiffSide): boolean {
  if (diffStore.busy) { return false; }
  if (!diffFor(side)) { return false; }
  diffStore.error = null;
  diffStore.busy = true;
  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => {
    stageTimer = undefined;
    diffStore.error = t('file.stageTimeout');
  }, STAGE_TIMEOUT_MS);
  return true;
}

/** Post a single hunk to the host; `side` decides stage vs unstage. */
export function postStageHunk(side: DiffSide, hunkIndex: number): void {
  if (!beginStageOp(side)) { return; }
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex },
  });
}

/** Post the gutter-selected changed lines of one hunk to the host; `side` decides
 *  stage vs unstage. */
export function postStageLines(side: DiffSide, hunkIndex: number, lineIndices: number[]): void {
  if (!beginStageOp(side)) { return; }
  vscode.postMessage({
    type: 'diffStageLines',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex, lineIndices },
  });
}
