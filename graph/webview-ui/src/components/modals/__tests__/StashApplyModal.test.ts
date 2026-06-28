import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import StashApplyModal from '../StashApplyModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  index: 0,
  message: 'WIP on main',
  drop: false,
  targetBranch: 'main',
  onClose: vi.fn(),
  onApply: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('StashApplyModal', () => {
  it('apply mode: primary fires onApply', async () => {
    const onApply = vi.fn();
    const { container } = render(StashApplyModal, { ...baseProps, onApply });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onApply).toHaveBeenCalled();
  });

  it('pop mode (drop=true) changes the modal title and button label', () => {
    const apply = render(StashApplyModal, baseProps);
    const applyTitle = apply.container.querySelector('h2,h3,.modal-title')?.textContent
      ?? apply.container.textContent ?? '';
    apply.unmount();

    const pop = render(StashApplyModal, { ...baseProps, drop: true });
    const popTitle = pop.container.querySelector('h2,h3,.modal-title')?.textContent
      ?? pop.container.textContent ?? '';
    expect(popTitle).not.toBe(applyTitle);
  });

  it('falls back to stash@{index} when message is empty', () => {
    const { container } = render(StashApplyModal, { ...baseProps, message: '' });
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('stash@{0}');
  });

  it('uses the message when provided', () => {
    const { container } = render(StashApplyModal, baseProps);
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('WIP on main');
  });

  it('cancel fires onClose, not onApply', async () => {
    const onClose = vi.fn();
    const onApply = vi.fn();
    const { container } = render(StashApplyModal, { ...baseProps, onClose, onApply });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
