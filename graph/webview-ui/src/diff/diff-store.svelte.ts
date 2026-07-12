// Webview-side state for the full-tab Diff panel: the current file's staged +
// unstaged DiffData shown as two stacked sections. Its own self-contained bundle
// (diff.js), separate from the graph and commit-box bundles.
import type { DiffData } from '../lib/types';

export type DiffSide = 'staged' | 'unstaged';

class DiffStore {
  repoPath = $state('');
  file = $state('');
  /** HEAD ↔ index (git diff --cached). null when nothing is staged for this file. */
  stagedDiff = $state<DiffData | null>(null);
  /** index ↔ working tree (git diff). null when nothing is unstaged for this file. */
  unstagedDiff = $state<DiffData | null>(null);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);
  /** True while a stage/unstage request is in flight. Gates further clicks on
   *  BOTH sections so a second click can't race the first: applying re-parses the
   *  diff and shifts every later hunk/line index, so a click before the fresh
   *  `diffShow` lands would target the wrong hunk. */
  busy = $state(false);

  /** True once a file has been shown (either side may still be null). Distinguishes
   *  "no file open yet" from "file open but one/both sides empty". Derived — the
   *  host always sends a non-empty file path in `diffShow`. */
  get loaded(): boolean {
    return this.file !== '';
  }

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.stagedDiff = null;
    this.unstagedDiff = null;
    this.error = null;
    this.busy = false;
  }

  setDiffs(repoPath: string, file: string, stagedDiff: DiffData | null, unstagedDiff: DiffData | null): void {
    this.repoPath = repoPath;
    this.file = file;
    this.stagedDiff = stagedDiff;
    this.unstagedDiff = unstagedDiff;
    this.error = null;
    this.busy = false;
  }
}

export const diffStore = new DiffStore();
