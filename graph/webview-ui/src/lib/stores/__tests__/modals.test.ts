import { describe, it, expect, beforeEach } from 'vitest';
import { modalStore } from '../modals.svelte';

// modalStore is a singleton, so each test must close everything before it
// touches state — otherwise leakage between tests masks bugs.
beforeEach(() => {
  modalStore.closeAll();
});

describe('modalStore.open/close', () => {
  it('openDeleteBranch sets show and name', () => {
    modalStore.openDeleteBranch('feature/login');
    expect(modalStore.deleteBranch).toEqual({ show: true, name: 'feature/login' });
  });

  it('closeDeleteBranch clears the name too (no stale leak)', () => {
    modalStore.openDeleteBranch('feature/login');
    modalStore.closeDeleteBranch();
    expect(modalStore.deleteBranch).toEqual({ show: false, name: '' });
  });

  it('openCreateBranch defaults subject to empty string', () => {
    modalStore.openCreateBranch('main');
    expect(modalStore.createBranch.startPoint).toBe('main');
    expect(modalStore.createBranch.subject).toBe('');
  });

  it('openMerge captures both source and target', () => {
    modalStore.openMerge('feature/x', 'main');
    expect(modalStore.merge).toEqual({ show: true, source: 'feature/x', target: 'main' });
  });

  it('openPush defaults to origin and no force', () => {
    modalStore.openPush();
    expect(modalStore.push.remote).toBe('origin');
    expect(modalStore.push.forceMode).toBe('none');
    expect(modalStore.push.setUpstream).toBe(true);
  });

  it('openPush honours custom remote', () => {
    modalStore.openPush('upstream');
    expect(modalStore.push.remote).toBe('upstream');
  });

  it('openPull defaults to rebase=true, stash=false', () => {
    modalStore.openPull();
    expect(modalStore.pull).toEqual({ show: true, rebase: true, stash: false });
  });
});

describe('modalStore.anyOpen', () => {
  it('returns false when nothing is open', () => {
    expect(modalStore.anyOpen).toBe(false);
  });

  it('returns true when any modal is open', () => {
    modalStore.openDeleteBranch('x');
    expect(modalStore.anyOpen).toBe(true);
  });

  it('returns true for each modal individually', () => {
    // Spot-check several different modals to confirm the getter actually
    // ORs across all the show flags it claims to.
    const checks: Array<[() => void, () => void]> = [
      // amend was historically omitted from anyOpen, so Esc on the Amend
      // modal leaked through to the global handler and cleared the selection.
      [() => modalStore.openAmend({ hash: 'h', subject: 's', message: 'm', isPushed: false }), () => modalStore.closeAmend()],
      [() => modalStore.openCreateBranch('main'), () => modalStore.closeCreateBranch()],
      [() => modalStore.openMerge('a', 'b'), () => modalStore.closeMerge()],
      [() => modalStore.openFetch(), () => modalStore.closeFetch()],
      [() => modalStore.openPush(), () => modalStore.closePush()],
      [() => modalStore.openFlowInit(), () => modalStore.closeFlowInit()],
    ];
    for (const [open, close] of checks) {
      open();
      expect(modalStore.anyOpen).toBe(true);
      close();
      expect(modalStore.anyOpen).toBe(false);
    }
  });
});

describe('modalStore — remaining open methods', () => {
  it('openStashRename captures index and message', () => {
    modalStore.openStashRename(3, 'wip thing');
    expect(modalStore.stashRename).toEqual({ show: true, index: 3, message: 'wip thing' });
  });

  it('openSetUpstream captures branch and currentUpstream (defaults blank)', () => {
    modalStore.openSetUpstream('feat');
    expect(modalStore.setUpstream).toEqual({ show: true, branchName: 'feat', currentUpstream: '' });
    modalStore.closeSetUpstream();
    modalStore.openSetUpstream('feat', 'origin/feat');
    expect(modalStore.setUpstream.currentUpstream).toBe('origin/feat');
  });

  it('openFlowStart captures the flow type', () => {
    modalStore.openFlowStart('release');
    expect(modalStore.flowStart).toEqual({ show: true, flowType: 'release' });
  });

  it('openPushTag defaults remote to origin', () => {
    modalStore.openPushTag('v1.0');
    expect(modalStore.pushTag).toEqual({ show: true, tagName: 'v1.0', remote: 'origin' });
    modalStore.closePushTag();
    modalStore.openPushTag('v1.0', 'fork');
    expect(modalStore.pushTag.remote).toBe('fork');
  });
});

describe('modalStore.openStashRestore', () => {
  it('captures index, message and paths', () => {
    modalStore.openStashRestore(2, 'wip', ['a.ts', 'b.ts']);
    expect(modalStore.stashRestore).toEqual({ show: true, index: 2, message: 'wip', paths: ['a.ts', 'b.ts'] });
    modalStore.closeStashRestore();
    expect(modalStore.stashRestore.show).toBe(false);
  });
});

describe('modalStore.closeForSource', () => {
  it('is a no-op when the source is undefined', () => {
    modalStore.openMerge('x', 'y');
    modalStore.closeForSource(undefined);
    expect(modalStore.merge.show).toBe(true); // left untouched
  });

  it('is a no-op for an unknown source', () => {
    modalStore.openMerge('x', 'y');
    modalStore.closeForSource('totallyUnknown');
    expect(modalStore.merge.show).toBe(true);
  });

  it('closes only the modal that originated the failing operation', () => {
    modalStore.openMerge('x', 'y');
    modalStore.openCreateBranch('main');
    modalStore.closeForSource('merge');
    expect(modalStore.merge.show).toBe(false);
    expect(modalStore.createBranch.show).toBe(true); // unrelated, stays open
  });

  it('maps the deleteRemoteTag source onto the deleteTag modal', () => {
    modalStore.openDeleteTag('v1.0');
    modalStore.closeForSource('deleteRemoteTag');
    expect(modalStore.deleteTag.show).toBe(false);
  });

  it('maps the checkout source onto the checkoutRemote modal', () => {
    modalStore.openCheckoutRemote('origin/feature', 'feature');
    modalStore.closeForSource('checkout');
    expect(modalStore.checkoutRemote.show).toBe(false);
  });

  it('maps stashPop and stashDrop onto the stashApply modal', () => {
    modalStore.openStashApply(0, 'wip', false);
    modalStore.closeForSource('stashPop');
    expect(modalStore.stashApply.show).toBe(false);

    modalStore.openStashApply(0, 'wip', true);
    modalStore.closeForSource('stashDrop');
    expect(modalStore.stashApply.show).toBe(false);
  });

  it('flowAction closes both flow modals', () => {
    modalStore.openFlowStart('feature');
    modalStore.openFlowFinish('feature', 'feature/x');
    modalStore.closeForSource('flowAction');
    expect(modalStore.flowStart.show).toBe(false);
    expect(modalStore.flowFinish.show).toBe(false);
  });

  it('handles every known source string without throwing', () => {
    const sources = [
      'deleteBranch', 'deleteTag', 'deleteRemoteTag', 'createBranch', 'createTag',
      'merge', 'checkout', 'checkoutRemote', 'renameBranch', 'deleteRemoteBranch',
      'worktreeAdd', 'worktreeRemove', 'stashApply', 'stashPop', 'stashDrop',
      'stashRename', 'stashSave', 'amendCommit', 'setUpstream', 'fetch', 'pull',
      'push', 'flowInit', 'flowStart', 'flowFinish', 'flowAction', 'pushTag', 'pushAllTags',
    ];
    for (const source of sources) {
      expect(() => modalStore.closeForSource(source)).not.toThrow();
    }
    expect(modalStore.anyOpen).toBe(false);
  });
});

describe('modalStore.closeAll', () => {
  it('closes every open modal in one call (used on extension error)', () => {
    modalStore.openCreateBranch('main');
    modalStore.openMerge('x', 'y');
    modalStore.openPush();
    modalStore.openFlowFinish('feature', 'feature/x');
    expect(modalStore.anyOpen).toBe(true);

    modalStore.closeAll();

    expect(modalStore.anyOpen).toBe(false);
    expect(modalStore.createBranch.show).toBe(false);
    expect(modalStore.merge.show).toBe(false);
    expect(modalStore.push.show).toBe(false);
    expect(modalStore.flowFinish.show).toBe(false);
  });

  it('closeAll covers every modal anyOpen tracks', () => {
    // Open one representative for each modal, then assert closeAll clears them
    // all. Because anyOpen is derived from MODAL_KEYS, a modal that closeAll
    // forgets (the failure mode this guards against) leaves anyOpen true here.
    modalStore.openDeleteBranch('b');
    modalStore.openDeleteTag('t');
    modalStore.openCreateBranch('main');
    modalStore.openCreateTag('main');
    modalStore.openMerge('x', 'y');
    modalStore.openCheckoutRemote('origin/x', 'x');
    modalStore.openRenameBranch('x');
    modalStore.openDeleteRemoteBranch('origin', 'x');
    modalStore.openRemoveWorktree('/p', 'x');
    modalStore.openStashApply(0, 'm', false);
    modalStore.openStashRename(0, 'm');
    modalStore.openStashSave();
    modalStore.openStashRestore(0, 'm', ['a']);
    modalStore.openAmend({ hash: 'h', subject: 's', message: 'm', isPushed: false });
    modalStore.openSetUpstream('x');
    modalStore.openFetch();
    modalStore.openPull();
    modalStore.openPush();
    modalStore.openFlowInit();
    modalStore.openFlowStart('feature');
    modalStore.openFlowFinish('feature', 'feature/x');
    modalStore.openPushTag('v1');
    expect(modalStore.anyOpen).toBe(true);

    modalStore.closeAll();
    expect(modalStore.anyOpen).toBe(false);
  });
});
