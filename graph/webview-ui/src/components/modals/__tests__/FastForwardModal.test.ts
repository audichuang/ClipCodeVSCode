import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import FastForwardModal from '../FastForwardModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  localBranch: 'main',
  remote: 'origin/main',
  isCurrentBranch: true,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('FastForwardModal', () => {
  it('confirm button fires onConfirm', async () => {
    const onConfirm = vi.fn();
    const { container } = render(FastForwardModal, { ...baseProps, onConfirm });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('renders both local and remote pills', () => {
    const { container } = render(FastForwardModal, baseProps);
    const text = container.textContent ?? '';
    expect(text).toContain('main');
    expect(text).toContain('origin/main');
  });

  it('cancel fires onClose, not onConfirm', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(FastForwardModal, { ...baseProps, onClose, onConfirm });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('current branch: no "without checkout" checkbox, confirms with checkout', async () => {
    const onConfirm = vi.fn();
    const { container } = render(FastForwardModal, { ...baseProps, isCurrentBranch: true, onConfirm });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('non-current branch: defaults to no-checkout and confirms with it', async () => {
    const onConfirm = vi.fn();
    const { container } = render(FastForwardModal, { ...baseProps, isCurrentBranch: false, onConfirm });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });
});
