// Webview-side state for the full-tab Diff panel: the current file's staged +
// unstaged DiffData shown as two stacked sections. Its own self-contained bundle
// (diff.js), separate from the graph and commit-box bundles.
import type { DiffData } from '../lib/types';

export type DiffSide = 'staged' | 'unstaged';

class DiffStore {
  repoPath = $state('');
  file = $state('');
  /* SNIPCODE-HOOK start: Batch B image request identity */
  generation = $state(0);
  /* SNIPCODE-HOOK end */
  /** HEAD ↔ index (git diff --cached). null when nothing is staged for this file. */
  stagedDiff = $state<DiffData | null>(null);
  /** index ↔ working tree (git diff). null when nothing is unstaged for this file. */
  unstagedDiff = $state<DiffData | null>(null);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);
  /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
  loading = $state(false);
  /* SNIPCODE-HOOK end */
  /** True while a stage/unstage request is in flight. Gates further clicks on
   *  BOTH sections so a second click can't race the first: applying re-parses the
   *  diff and shifts every later hunk/line index, so a click before the fresh
   *  `diffShow` lands would target the wrong hunk. */
  busy = $state(false);
  /* SNIPCODE-HOOK start: Batch B stage operation correlation */
  operationId = $state<string | null>(null);
  /* SNIPCODE-HOOK end */

  /** True once a file has been shown (either side may still be null). Distinguishes
   *  "no file open yet" from "file open but one/both sides empty". Derived — the
   *  host always sends a non-empty file path in `diffShow`. */
  get loaded(): boolean {
    return this.file !== '';
  }

  reset(): void {
    this.repoPath = '';
    this.file = '';
    /* SNIPCODE-HOOK start: Batch B image request identity */
    this.generation = 0;
    /* SNIPCODE-HOOK end */
    this.stagedDiff = null;
    this.unstagedDiff = null;
    this.error = null;
    /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
    this.loading = false;
    /* SNIPCODE-HOOK end */
    this.busy = false;
    /* SNIPCODE-HOOK start: Batch B stage operation correlation */
    this.operationId = null;
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start: Batch B image request identity */
  /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
  beginLoad(repoPath: string, file: string, generation: number, operationId?: string): void {
    this.repoPath = repoPath;
    this.file = file;
    this.generation = generation;
    this.stagedDiff = null;
    this.unstagedDiff = null;
    this.error = null;
    this.loading = true;
    if (operationId === undefined) {
      this.busy = false;
      this.operationId = null;
    }
  }
  /* SNIPCODE-HOOK end */

  setDiffs(repoPath: string, file: string, stagedDiff: DiffData | null, unstagedDiff: DiffData | null, generation = 0): void {
    this.repoPath = repoPath;
    this.file = file;
    this.generation = generation;
    this.stagedDiff = stagedDiff;
    this.unstagedDiff = unstagedDiff;
    this.error = null;
    /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
    this.loading = false;
    /* SNIPCODE-HOOK end */
    this.busy = false;
    /* SNIPCODE-HOOK start: Batch B stage operation correlation */
    this.operationId = null;
    /* SNIPCODE-HOOK end */
  }
  /* SNIPCODE-HOOK end */
}

export const diffStore = new DiffStore();
