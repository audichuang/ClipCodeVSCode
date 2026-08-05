// Webview-side state for the commit box. The change list (Staged/Unstaged →
// repo → file) is now the native TreeView; this webview is ONLY the shared
// commit message box + Commit/Amend, so the store holds just the draft message
// and in-flight/commit-result state.

export interface WbCommitResult { repoName: string; ok: boolean; error?: string }

class CommitBoxStore {
  message = $state('');
  committing = $state(false);
  /** Soft error surfaced when a commit round-trip times out (view disposed mid-commit). */
  commitError = $state<string | null>(null);
  /** Per-repo outcome of the last commit (for a small summary line). */
  results = $state<WbCommitResult[]>([]);
  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  stagedRepoCount = $state(0);
  /* SNIPCODE-HOOK end */

  reset(): void {
    this.message = '';
    this.committing = false;
    this.commitError = null;
    this.results = [];
    /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
    this.stagedRepoCount = 0;
    /* SNIPCODE-HOOK end */
  }

  applyCommitResults(results: WbCommitResult[]): void {
    this.results = results;
    // Clear the message only when every repo committed cleanly; on any failure
    // keep it so the user can retry without retyping.
    if (results.length > 0 && results.every((r) => r.ok)) this.message = '';
    this.committing = false;
  }

  get canCommit(): boolean {
    return this.message.trim() !== '' && !this.committing;
  }
  get canAmend(): boolean {
    /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
    return this.canCommit && this.stagedRepoCount === 1;
    /* SNIPCODE-HOOK end */
  }
}

export const workbenchStore = new CommitBoxStore();
