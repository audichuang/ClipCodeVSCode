// Webview-side state for the full-tab Diff panel: the current file's DiffData +
// which index side it's on. Its own self-contained bundle (diff.js), separate
// from the graph and commit-box bundles.
import type { DiffData } from '../lib/types';

export type DiffSide = 'staged' | 'unstaged';

class DiffStore {
  repoPath = $state('');
  file = $state('');
  side = $state<DiffSide>('unstaged');
  diff = $state<DiffData | null>(null);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.side = 'unstaged';
    this.diff = null;
    this.error = null;
  }

  setDiff(repoPath: string, file: string, side: DiffSide, diff: DiffData | null): void {
    this.repoPath = repoPath;
    this.file = file;
    this.side = side;
    this.diff = diff;
    this.error = null;
  }
}

export const diffStore = new DiffStore();
