import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import PullAfterCheckoutModal from '../PullAfterCheckoutModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  branchName: 'main',
  behind: 3,
  onClose: vi.fn(),
  onCheckoutOnly: vi.fn(),
  onCheckoutAndPull: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });

describe('PullAfterCheckoutModal', () => {
  it('primary button fires onCheckoutAndPull', async () => {
    const onCheckoutAndPull = vi.fn();
    const { container } = render(PullAfterCheckoutModal, { ...baseProps, onCheckoutAndPull });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckoutAndPull).toHaveBeenCalled();
  });

  it('checkout-only (middle) button fires onCheckoutOnly', async () => {
    const onCheckoutOnly = vi.fn();
    const { container } = render(PullAfterCheckoutModal, { ...baseProps, onCheckoutOnly });
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    await fireEvent.click(buttons[buttons.length - 2]); // middle of 3 form-actions buttons
    expect(onCheckoutOnly).toHaveBeenCalled();
  });

  it('cancel fires onClose only', async () => {
    const onClose = vi.fn();
    const onCheckoutOnly = vi.fn();
    const onCheckoutAndPull = vi.fn();
    const { container } = render(PullAfterCheckoutModal, {
      ...baseProps, onClose, onCheckoutOnly, onCheckoutAndPull,
    });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onCheckoutOnly).not.toHaveBeenCalled();
    expect(onCheckoutAndPull).not.toHaveBeenCalled();
  });

  it('renders branch name in the context card', () => {
    const { container } = render(PullAfterCheckoutModal, baseProps);
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('main');
  });
});
