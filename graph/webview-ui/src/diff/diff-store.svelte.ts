// Webview-side state for the Diff view: the current file's hunks + which hunks
// are checked to be staged/unstaged. Its own bundle/context (self-contained
// diff.js), separate from the graph and the commit box.

export type DiffSide = 'staged' | 'unstaged';

export interface DiffHunkView {
  header: string;
  lines: Array<{ type: 'context' | 'add' | 'delete'; content: string }>;
}

class DiffStore {
  repoPath = $state('');
  file = $state('');
  side = $state<DiffSide>('unstaged');
  hunks = $state<DiffHunkView[]>([]);
  /** Hunk indices the user has checked to apply. Reassigned (never mutated) so
   *  Svelte repaints. */
  checked = $state<Set<number>>(new Set());
  /** True while a stage/unstage round-trip is in flight (disables the button). */
  busy = $state(false);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.side = 'unstaged';
    this.hunks = [];
    this.checked = new Set();
    this.busy = false;
    this.error = null;
  }

  setDiff(repoPath: string, file: string, side: DiffSide, hunks: DiffHunkView[]): void {
    this.repoPath = repoPath;
    this.file = file;
    this.side = side;
    this.hunks = hunks;
    this.checked = new Set(hunks.map((_, i) => i)); // default: every hunk selected
    this.busy = false;
    this.error = null;
  }

  toggle(i: number): void {
    const next = new Set(this.checked);
    if (next.has(i)) { next.delete(i); } else { next.add(i); }
    this.checked = next;
  }

  selectAll(): void {
    this.checked = new Set(this.hunks.map((_, i) => i));
  }

  clear(): void {
    this.checked = new Set();
  }

  get selectedIndices(): number[] {
    return [...this.checked].sort((a, b) => a - b);
  }

  get canApply(): boolean {
    return this.hunks.length > 0 && this.checked.size > 0 && !this.busy;
  }

  get actionLabel(): string {
    return this.side === 'staged' ? 'Unstage 選取' : 'Stage 選取';
  }
}

export const diffStore = new DiffStore();
