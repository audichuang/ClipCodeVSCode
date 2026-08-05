// Workbench-only message protocol. Kept SEPARATE from src/utils/message-bus.ts
// so the commit workbench never rides MainPanel's transaction gate — it
// serializes its own mutations through runExclusive (mutation-coordinator.ts).
// No vscode import: this file is pure types + one const record, unit-testable.

export type MessageEffect = 'mutation' | 'read';

/** One changed file in a repo (D3 minimal: whole-file granularity in B-2a). */
export interface WorkbenchFileChange {
  /** Repo-relative path (POSIX-style, as git reports it). */
  path: string;
  /** git status letter for the worktree side: M/A/D/R/U/N (N = nested repo). */
  changeType: string;
  /** Number of diff hunks (0 for non-hunkable: binary/submodule/nested/new-untracked-binary). */
  hunkCount: number;
  /** False → must be committed whole (binary/submodule/nested); no per-hunk in B-2a. */
  hunkable: boolean;
}

/** Per-repo group + commit-availability signals (D4 banner). */
export interface RepoStatus {
  repoPath: string;
  repoName: string;
  files: WorkbenchFileChange[];
  /** clean | merge | rebase | cherry-pick | revert | bisect (getRepoOperationState). */
  operationState: string;
  /** True when the git index already has staged content (D1 → block commit). */
  indexDirty: boolean;
  /** True on detached HEAD (D4 → allow but warn). */
  detached: boolean;
  /**
   * Non-null → this repo's Commit is disabled; string is the user-facing reason
   * (index 非空 / in-progress op). Detached is a WARNING, not a block, so it does
   * NOT set this field. Computed host-side in Task 2 so the webview stays dumb.
   */
  commitDisabledReason: string | null;
}

export interface WorkbenchStatus {
  repos: RepoStatus[];
}

/** A repo's selection sent by the webview at Commit time (whole-file only). */
export interface PerRepoSelection {
  repoPath: string;
  /** Files the user checked, each with the hunk count so host expands to [0..n-1]. */
  files: Array<{ path: string; hunkCount: number }>;
}

/** Per-repo commit outcome returned to the webview (D-Slice B partial-failure). */
export interface RepoCommitResult {
  repoPath: string;
  ok: boolean;
  newHead?: string;
  error?: string;
}

// --- Webview → Host -------------------------------------------------------
export type WorkbenchWebviewMessage =
  | { type: 'workbenchGetStatus' }
  | {
      type: 'workbenchCommit';
      payload: {
        message: string;
        amend: boolean;
        repos: PerRepoSelection[];
      };
    };

// --- Host → Webview -------------------------------------------------------
export type WorkbenchExtensionMessage =
  | { type: 'workbenchStatus'; payload: WorkbenchStatus }
  | { type: 'workbenchCommitResult'; payload: { results: RepoCommitResult[] } }
  | { type: 'error'; payload: { message: string; source?: string } };

/**
 * Exhaustive by construction: adding a WorkbenchWebviewMessage type without a
 * classification here is a COMPILE error (Record over the union's 'type').
 * 'mutation' handlers wrap their git work in runExclusive; 'read' don't.
 */
export const WORKBENCH_MESSAGE_EFFECTS: Record<WorkbenchWebviewMessage['type'], MessageEffect> = {
  workbenchGetStatus: 'read',
  workbenchCommit: 'mutation',
};
