import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import DeleteBranchModal from '../DeleteBranchModal.svelte';
import { i18n, t } from '../../../lib/i18n/index.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

function resetStore() {
  branchStore.branches = [];
  branchStore.tags = [];
  branchStore.remotes = [];
  branchStore.stashes = [];
  branchStore.worktrees = [];
}

const baseProps = {
  branchName: 'feature/x',
  onClose: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
  resetStore();
});
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('DeleteBranchModal — payload', () => {
  it('default delete passes force=false, no worktree path, deleteRemote=false', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false, undefined, false);
  });

  it('checking -D toggles force=true', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    const forceBox = container.querySelector<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(forceBox);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete.mock.calls[0][0]).toBe(true);
  });

  it('cancel fires onClose, not onDelete', async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onClose, onDelete });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('DeleteBranchModal — linked worktree warning', () => {
  it('shows warning + passes worktree path when branch is checked out in another worktree', async () => {
    branchStore.worktrees = [
      { path: '/main/repo', hash: 'h0', branch: 'main', detached: false, locked: false, prunable: false, isMain: true },
      { path: '/repo/wt-1', hash: 'h1', branch: 'feature/x', detached: false, locked: false, prunable: false, isMain: false },
    ];
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    expect(container.querySelector('.modal-warning')).not.toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false, '/repo/wt-1', false);
  });

  it('does not pass a worktree path when no non-main worktree has the branch', async () => {
    branchStore.worktrees = [
      { path: '/main/repo', hash: 'h0', branch: 'feature/x', detached: false, locked: false, prunable: false, isMain: true },
    ];
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    expect(container.querySelector('.modal-warning')).toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete.mock.calls[0][1]).toBeUndefined();
  });
});

describe('DeleteBranchModal — defaults store', () => {
  it('shows no destructive-default banner when defaults are false', () => {
    const { container } = render(DeleteBranchModal, baseProps);
    const bannerText = t('deleteBranch.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
  });

  it('initializes deleteRemote from store and shows banner when deleteRemote default is true', () => {
    // Set up store so deleteRemote option is visible
    branchStore.branches = [
      { name: 'feature/x', current: false, ahead: 0, behind: 0, hash: 'h', upstream: 'origin/feature/x' },
      { name: 'origin/feature/x', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
    ];
    branchStore.remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
    defaultsStore.current.deleteBranch = { force: false, deleteRemote: true };
    const { container } = render(DeleteBranchModal, baseProps);
    const boxes = container.querySelectorAll<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]');
    expect(boxes[1].checked).toBe(true); // deleteRemote checkbox is checked
    const bannerText = t('deleteBranch.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.some(el => el.textContent?.includes(bannerText))).toBe(true);
  });

  it('ignores the deleteRemote default when the branch has no remote (no warning, passes false)', async () => {
    defaultsStore.current.deleteBranch = { force: false, deleteRemote: true };
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    const bannerText = t('deleteBranch.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false, undefined, false);
  });
});

describe('DeleteBranchModal — remote-delete option', () => {
  it('shows the "delete remote" checkbox when upstream remote branch exists', async () => {
    branchStore.branches = [
      { name: 'feature/x', current: false, ahead: 0, behind: 0, hash: 'h', upstream: 'origin/feature/x' },
      { name: 'origin/feature/x', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
    ];
    branchStore.remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
    const { container } = render(DeleteBranchModal, baseProps);
    const boxes = container.querySelectorAll('label.modal-checkbox');
    expect(boxes.length).toBe(2); // force + delete remote
  });

  it('detects an unconfigured remote via name fallback', () => {
    branchStore.branches = [
      { name: 'feature/x', current: false, ahead: 0, behind: 0, hash: 'h' },
      { name: 'origin/feature/x', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
    ];
    branchStore.remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
    const { container } = render(DeleteBranchModal, baseProps);
    expect(container.querySelectorAll('label.modal-checkbox').length).toBe(2);
  });

  it('hides the "delete remote" checkbox when no matching remote branch exists', () => {
    branchStore.branches = [
      { name: 'feature/x', current: false, ahead: 0, behind: 0, hash: 'h' },
    ];
    branchStore.remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
    const { container } = render(DeleteBranchModal, baseProps);
    expect(container.querySelectorAll('label.modal-checkbox').length).toBe(1);
  });

  it('checking the deleteRemote box propagates into payload', async () => {
    branchStore.branches = [
      { name: 'feature/x', current: false, ahead: 0, behind: 0, hash: 'h', upstream: 'origin/feature/x' },
      { name: 'origin/feature/x', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
    ];
    branchStore.remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
    const onDelete = vi.fn();
    const { container } = render(DeleteBranchModal, { ...baseProps, onDelete });
    const boxes = container.querySelectorAll<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]');
    await fireEvent.click(boxes[1]); // deleteRemote
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete.mock.calls[0][2]).toBe(true);
  });
});
