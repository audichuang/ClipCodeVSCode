import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import WorktreeBlockedModal from '../WorktreeBlockedModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  branchRef: 'feature/x',
  displayPath: '/repo/worktrees/feature-x',
  onClose: vi.fn(),
  onOpenInNewWindow: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });

describe('WorktreeBlockedModal', () => {
  it('primary button fires onOpenInNewWindow', async () => {
    const onOpenInNewWindow = vi.fn();
    const { container } = render(WorktreeBlockedModal, { ...baseProps, onOpenInNewWindow });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onOpenInNewWindow).toHaveBeenCalled();
  });

  it('close (secondary) button fires onClose only', async () => {
    const onClose = vi.fn();
    const onOpenInNewWindow = vi.fn();
    const { container } = render(WorktreeBlockedModal, { ...baseProps, onClose, onOpenInNewWindow });
    // Modal adds an X header button; in-body order is: [primary, close text button].
    const closeBtn = container.querySelectorAll<HTMLButtonElement>('.form-actions button')[1];
    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
    expect(onOpenInNewWindow).not.toHaveBeenCalled();
  });

  it('renders branch ref and worktree path', () => {
    const { container } = render(WorktreeBlockedModal, baseProps);
    const text = container.textContent ?? '';
    expect(text).toContain('feature/x');
    expect(text).toContain('/repo/worktrees/feature-x');
  });
});
