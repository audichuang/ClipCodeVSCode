import type { BranchInfo, TagInfo, RemoteInfo, StashEntry, WorktreeInfo, BranchData } from '../types';

class BranchStore {
  branches = $state<BranchInfo[]>([]);
  tags = $state<TagInfo[]>([]);
  remotes = $state<RemoteInfo[]>([]);
  stashes = $state<StashEntry[]>([]);
  worktrees = $state<WorktreeInfo[]>([]);

  // Derived so they only recompute when `branches` changes, not on every
  // access. currentBranch in particular is read many times while building a
  // single context menu, where the old plain-getter Array.find() re-ran each
  // time.
  private _localBranches = $derived(this.branches.filter((b) => !b.remote));
  private _remoteBranches = $derived(this.branches.filter((b) => !!b.remote));
  private _currentBranch = $derived(this.branches.find((b) => b.current));

  get localBranches(): BranchInfo[] {
    return this._localBranches;
  }

  get remoteBranches(): BranchInfo[] {
    return this._remoteBranches;
  }

  get currentBranch(): BranchInfo | undefined {
    return this._currentBranch;
  }

  setData(data: BranchData) {
    this.branches = data.branches;
    this.tags = data.tags;
    this.remotes = data.remotes;
    this.stashes = data.stashes;
    this.worktrees = data.worktrees ?? [];
  }
}

export const branchStore = new BranchStore();
