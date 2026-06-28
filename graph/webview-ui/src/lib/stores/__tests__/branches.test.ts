import { describe, it, expect, beforeEach } from 'vitest';
import { branchStore } from '../branches.svelte';
import type { BranchInfo, BranchData } from '../../types';

function makeBranch(overrides: Partial<BranchInfo>): BranchInfo {
  return {
    name: 'main',
    current: false,
    remote: undefined,
    upstream: undefined,
    hash: 'abc123',
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

const emptyData: BranchData = { branches: [], tags: [], remotes: [], stashes: [], worktrees: [] };

beforeEach(() => {
  branchStore.setData(emptyData);
});

describe('branchStore.setData', () => {
  it('replaces all fields from the payload', () => {
    branchStore.setData({
      branches: [makeBranch({ name: 'main', current: true })],
      tags: [{ name: 'v1.0', hash: 'abc', isAnnotated: false }],
      remotes: [{ name: 'origin', fetchUrl: 'git@x', pushUrl: 'git@x' }],
      stashes: [{ index: 0, message: 'wip', date: '' }],
      worktrees: [],
    });
    expect(branchStore.branches).toHaveLength(1);
    expect(branchStore.tags).toHaveLength(1);
    expect(branchStore.remotes).toHaveLength(1);
    expect(branchStore.stashes).toHaveLength(1);
  });

  it('defaults worktrees to [] when payload omits it', () => {
    branchStore.setData({ ...emptyData, worktrees: undefined as unknown as [] });
    expect(branchStore.worktrees).toEqual([]);
  });
});

describe('branchStore derived getters', () => {
  beforeEach(() => {
    branchStore.setData({
      ...emptyData,
      branches: [
        makeBranch({ name: 'main', current: true }),
        makeBranch({ name: 'feature/login' }),
        makeBranch({ name: 'main', remote: 'origin' }),
        makeBranch({ name: 'develop', remote: 'upstream' }),
      ],
    });
  });

  it('localBranches excludes remote-tracking refs', () => {
    expect(branchStore.localBranches.map(b => b.name)).toEqual(['main', 'feature/login']);
  });

  it('remoteBranches includes only refs with a remote', () => {
    expect(branchStore.remoteBranches.map(b => b.remote)).toEqual(['origin', 'upstream']);
  });

  it('currentBranch returns the one with current=true', () => {
    expect(branchStore.currentBranch?.name).toBe('main');
    expect(branchStore.currentBranch?.current).toBe(true);
  });

  it('currentBranch is undefined when HEAD is detached', () => {
    branchStore.setData({
      ...emptyData,
      branches: [makeBranch({ name: 'main', current: false })],
    });
    expect(branchStore.currentBranch).toBeUndefined();
  });
});
