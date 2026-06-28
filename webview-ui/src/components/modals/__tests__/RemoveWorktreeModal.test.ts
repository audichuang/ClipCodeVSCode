import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import RemoveWorktreeModal from '../RemoveWorktreeModal.svelte';
import { i18n, t } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  path: '/repo/wt-feat',
  branch: 'feat/x',
  onClose: vi.fn(),
  onRemove: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('RemoveWorktreeModal', () => {
  it('default remove passes deleteBranch=false', async () => {
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onRemove });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onRemove).toHaveBeenCalledWith(false);
  });

  it('checking deleteBranch propagates true', async () => {
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onRemove });
    await fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onRemove).toHaveBeenCalledWith(true);
  });

  it('hides the deleteBranch checkbox when branch is empty (detached worktree)', () => {
    const { container } = render(RemoveWorktreeModal, { ...baseProps, branch: '' });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('cancel fires onClose, not onRemove', async () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onClose, onRemove });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('shows no destructive-default banner when defaults are false', () => {
    const { container } = render(RemoveWorktreeModal, baseProps);
    const bannerText = t('removeWorktree.deleteBranchWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
  });

  it('initializes deleteBranch from store, checkbox checked and banner shown when deleteBranch default is true', () => {
    defaultsStore.current.removeWorktree = { deleteBranch: true };
    const { container } = render(RemoveWorktreeModal, baseProps);
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    const bannerText = t('removeWorktree.deleteBranchWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.some(el => el.textContent?.includes(bannerText))).toBe(true);
  });

  it('ignores the deleteBranch default for a detached worktree (no branch)', async () => {
    defaultsStore.current.removeWorktree = { deleteBranch: true };
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, branch: '', onRemove });
    const bannerText = t('removeWorktree.deleteBranchWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onRemove).toHaveBeenCalledWith(false);
  });
});
