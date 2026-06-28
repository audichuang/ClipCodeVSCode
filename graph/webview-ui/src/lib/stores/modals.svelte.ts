/**
 * Centralized modal state store.
 * Any component can call modalStore.openXxx() to show a modal.
 * Only App.svelte renders the modals, preventing duplication.
 */

class ModalStore {
  // ── Delete Branch ──
  deleteBranch = $state({ show: false, name: '' });
  openDeleteBranch(name: string) { this.deleteBranch = { show: true, name }; }
  closeDeleteBranch() { this.deleteBranch = { show: false, name: '' }; }

  // ── Delete Tag ──
  deleteTag = $state({ show: false, name: '' });
  openDeleteTag(name: string) { this.deleteTag = { show: true, name }; }
  closeDeleteTag() { this.deleteTag = { show: false, name: '' }; }

  // ── Create Branch ──
  createBranch = $state({ show: false, startPoint: '', subject: '' });
  openCreateBranch(startPoint: string, subject = '') { this.createBranch = { show: true, startPoint, subject }; }
  closeCreateBranch() { this.createBranch = { show: false, startPoint: '', subject: '' }; }

  // ── Create Tag ──
  createTag = $state({ show: false, ref: '', subject: '' });
  openCreateTag(ref: string, subject = '') { this.createTag = { show: true, ref, subject }; }
  closeCreateTag() { this.createTag = { show: false, ref: '', subject: '' }; }

  // ── Merge Branch ──
  merge = $state({ show: false, source: '', target: '' });
  openMerge(source: string, target: string) { this.merge = { show: true, source, target }; }
  closeMerge() { this.merge = { show: false, source: '', target: '' }; }

  // ── Checkout Remote ──
  checkoutRemote = $state<{ show: boolean; remoteName: string; localName: string; dirty: boolean; dirtyPayload: Record<string, boolean> }>({ show: false, remoteName: '', localName: '', dirty: false, dirtyPayload: {} });
  openCheckoutRemote(remoteName: string, localName: string, dirty = false, dirtyPayload: Record<string, boolean> = {}) { this.checkoutRemote = { show: true, remoteName, localName, dirty, dirtyPayload }; }
  closeCheckoutRemote() { this.checkoutRemote = { show: false, remoteName: '', localName: '', dirty: false, dirtyPayload: {} }; }

  // ── Rename Branch ──
  renameBranch = $state({ show: false, oldName: '' });
  openRenameBranch(oldName: string) { this.renameBranch = { show: true, oldName }; }
  closeRenameBranch() { this.renameBranch = { show: false, oldName: '' }; }

  // ── Delete Remote Branch ──
  deleteRemoteBranch = $state({ show: false, remote: '', name: '' });
  openDeleteRemoteBranch(remote: string, name: string) { this.deleteRemoteBranch = { show: true, remote, name }; }
  closeDeleteRemoteBranch() { this.deleteRemoteBranch = { show: false, remote: '', name: '' }; }

  // ── Remove Worktree ──
  removeWorktree = $state({ show: false, path: '', branch: '' });
  openRemoveWorktree(path: string, branch: string) { this.removeWorktree = { show: true, path, branch }; }
  closeRemoveWorktree() { this.removeWorktree = { show: false, path: '', branch: '' }; }

  // ── Stash Apply/Pop ──
  stashApply = $state({ show: false, index: 0, message: '', drop: false });
  openStashApply(index: number, message: string, drop: boolean) { this.stashApply = { show: true, index, message, drop }; }
  closeStashApply() { this.stashApply = { show: false, index: 0, message: '', drop: false }; }

  // ── Stash Rename ──
  stashRename = $state({ show: false, index: 0, message: '' });
  openStashRename(index: number, message: string) { this.stashRename = { show: true, index, message }; }
  closeStashRename() { this.stashRename = { show: false, index: 0, message: '' }; }

  // ── Stash Save ──
  stashSave = $state({ show: false });
  openStashSave() { this.stashSave = { show: true }; }
  closeStashSave() { this.stashSave = { show: false }; }

  // ── Stash Restore (partial) ──
  stashRestore = $state<{ show: boolean; index: number; message: string; paths: string[] }>({ show: false, index: 0, message: '', paths: [] });
  openStashRestore(index: number, message: string, paths: string[]) { this.stashRestore = { show: true, index, message, paths }; }
  closeStashRestore() { this.stashRestore = { show: false, index: 0, message: '', paths: [] }; }

  // ── Amend (last commit) ──
  amend = $state<{ show: boolean; hash: string; subject: string; message: string; isPushed: boolean }>({ show: false, hash: '', subject: '', message: '', isPushed: false });
  openAmend(p: { hash: string; subject: string; message: string; isPushed: boolean }) { this.amend = { show: true, ...p }; }
  closeAmend() { this.amend = { show: false, hash: '', subject: '', message: '', isPushed: false }; }

  // ── Set Upstream ──
  setUpstream = $state({ show: false, branchName: '', currentUpstream: '' });
  openSetUpstream(branchName: string, currentUpstream?: string) { this.setUpstream = { show: true, branchName, currentUpstream: currentUpstream ?? '' }; }
  closeSetUpstream() { this.setUpstream = { show: false, branchName: '', currentUpstream: '' }; }

  // ── Fetch ──
  fetch = $state({ show: false, allRemotes: false, remote: 'origin' });
  openFetch(remote = 'origin') { this.fetch = { show: true, allRemotes: false, remote }; }
  closeFetch() { this.fetch = { show: false, allRemotes: false, remote: 'origin' }; }

  // ── Pull ──
  pull = $state({ show: false, rebase: true, stash: false });
  openPull() { this.pull = { show: true, rebase: true, stash: false }; }
  closePull() { this.pull = { show: false, rebase: true, stash: false }; }

  // ── Push ──
  push = $state({ show: false, forceMode: 'none' as 'none' | 'with-lease' | 'force', setUpstream: true, remote: 'origin', allTags: false });
  openPush(remote = 'origin') { this.push = { show: true, forceMode: 'none', setUpstream: true, remote, allTags: false }; }
  closePush() { this.push = { show: false, forceMode: 'none', setUpstream: true, remote: 'origin', allTags: false }; }

  // ── Flow Init ──
  flowInit = $state({ show: false });
  openFlowInit() { this.flowInit = { show: true }; }
  closeFlowInit() { this.flowInit = { show: false }; }

  // ── Flow Start ──
  flowStart = $state({ show: false, flowType: '' as string });
  openFlowStart(flowType: string) { this.flowStart = { show: true, flowType }; }
  closeFlowStart() { this.flowStart = { show: false, flowType: '' }; }

  // ── Flow Finish ──
  flowFinish = $state({ show: false, flowType: '' as string, branchName: '' });
  openFlowFinish(flowType: string, branchName: string) { this.flowFinish = { show: true, flowType, branchName }; }
  closeFlowFinish() { this.flowFinish = { show: false, flowType: '', branchName: '' }; }

  // ── Push Tag ──
  pushTag = $state({ show: false, tagName: '', remote: 'origin' });
  openPushTag(tagName: string, remote = 'origin') { this.pushTag = { show: true, tagName, remote }; }
  closePushTag() { this.pushTag = { show: false, tagName: '', remote: 'origin' }; }

  // Single source of truth for "which fields are modals". anyOpen derives from
  // this instead of a hand-maintained OR-chain that historically forgot newly
  // added modals (e.g. amend). Svelte compiles class $state fields to prototype
  // getters, so they aren't enumerable on the instance and must be listed by
  // name; reading this[key].show through the getter keeps anyOpen reactive.
  private static readonly MODAL_KEYS = [
    'deleteBranch', 'deleteTag', 'createBranch', 'createTag', 'merge', 'checkoutRemote',
    'renameBranch', 'deleteRemoteBranch', 'removeWorktree', 'stashApply', 'stashRename',
    'stashSave', 'stashRestore', 'amend', 'setUpstream', 'fetch', 'pull', 'push',
    'flowInit', 'flowStart', 'flowFinish', 'pushTag',
  ] as const;

  get anyOpen(): boolean {
    return ModalStore.MODAL_KEYS.some(k => (this[k] as { show: boolean }).show);
  }

  /** Map of WebviewMessage type → close fn. When the extension reports an
   *  error tagged with `source`, only the modal that originated the failing
   *  operation is closed — unrelated modals (e.g. CreateBranch being filled
   *  out while a background getStats errors) stay open. */
  closeForSource(source: string | undefined): void {
    if (!source) return;
    const map: Record<string, () => void> = {
      deleteBranch: () => this.closeDeleteBranch(),
      deleteTag: () => this.closeDeleteTag(),
      deleteRemoteTag: () => this.closeDeleteTag(),
      createBranch: () => this.closeCreateBranch(),
      createTag: () => this.closeCreateTag(),
      merge: () => this.closeMerge(),
      checkout: () => this.closeCheckoutRemote(),
      checkoutRemote: () => this.closeCheckoutRemote(),
      renameBranch: () => this.closeRenameBranch(),
      deleteRemoteBranch: () => this.closeDeleteRemoteBranch(),
      worktreeAdd: () => { /* no AddWorktree modal in modalStore; handled in-component */ },
      worktreeRemove: () => this.closeRemoveWorktree(),
      stashApply: () => this.closeStashApply(),
      stashPop: () => this.closeStashApply(),
      stashDrop: () => this.closeStashApply(),
      stashRename: () => this.closeStashRename(),
      stashSave: () => this.closeStashSave(),
      amendCommit: () => this.closeAmend(),
      setUpstream: () => this.closeSetUpstream(),
      fetch: () => this.closeFetch(),
      pull: () => this.closePull(),
      push: () => this.closePush(),
      flowInit: () => this.closeFlowInit(),
      flowStart: () => this.closeFlowStart(),
      flowFinish: () => this.closeFlowFinish(),
      // The flowStart/flowFinish modals dispatch a single 'flowAction' message
      // (not 'flowStart'/'flowFinish' verbatim). Close both if either errors;
      // only the actually-open one will be affected.
      flowAction: () => { this.closeFlowStart(); this.closeFlowFinish(); },
      pushTag: () => this.closePushTag(),
      pushAllTags: () => this.closePushTag(),
    };
    map[source]?.();
  }

  /** Close every open modal. Called when the extension reports an error so the
   *  user is not left staring at a stale modal whose operation has already failed. */
  closeAll() {
    this.closeDeleteBranch();
    this.closeDeleteTag();
    this.closeCreateBranch();
    this.closeCreateTag();
    this.closeMerge();
    this.closeCheckoutRemote();
    this.closeRenameBranch();
    this.closeDeleteRemoteBranch();
    this.closeRemoveWorktree();
    this.closeStashApply();
    this.closeStashRename();
    this.closeStashSave();
    this.closeStashRestore();
    this.closeAmend();
    this.closeSetUpstream();
    this.closeFetch();
    this.closePull();
    this.closePush();
    this.closeFlowInit();
    this.closeFlowStart();
    this.closeFlowFinish();
    this.closePushTag();
  }
}

export const modalStore = new ModalStore();
