import { uiStore } from './stores/ui.svelte';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

// Mutating operations that rewrite history / move refs / touch the working tree.
// Posting any of these flips uiStore.operating so the graph can show an immediate
// busy indicator during the git op + refresh round-trip (otherwise the button
// press appears to do nothing until the full refresh lands). It is cleared on
// every terminal message in App.svelte's handler. Read-only requests (getLog,
// getStats, getCommitDiff, switchRepo, …) are intentionally NOT listed.
const MUTATING_OPS = new Set<string>([
  'interactiveRebase', 'reset', 'rebase', 'dragRebase', 'dragMerge', 'merge',
  'cherryPick', 'revert', 'checkout', 'createBranch', 'deleteBranch',
  'deleteRemoteBranch', 'renameBranch', 'fastForward', 'setUpstream',
  'stashSave', 'stashApply', 'stashDrop', 'stashRename', 'createTag', 'deleteTag',
  'worktreeAdd', 'worktreeRemove', 'amendCommit', 'rewordCommit',
  'fetch', 'pull', 'push', 'addRemote', 'removeRemote',
  'abortMerge', 'abortRebase', 'continueRebase', 'skipRebase',
  'deleteRemoteTag', 'pushTag', 'pushAllTags', 'restoreStashFiles',
  'reverseCommitChanges', 'flowInit', 'flowAction',
  'continueOperation', 'abortOperation',
]);

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    const raw = acquireVsCodeApi();
    api = {
      postMessage(message: unknown): void {
        const type = (message as { type?: string } | null)?.type;
        if (type && MUTATING_OPS.has(type)) {
          uiStore.operating = type;
        }
        raw.postMessage(message);
      },
      getState: () => raw.getState(),
      setState: (state: unknown) => raw.setState(state),
    };
  }
  return api;
}
