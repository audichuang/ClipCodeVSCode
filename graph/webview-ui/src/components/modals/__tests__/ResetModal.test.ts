import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ResetModal from '../ResetModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  hash: 'abcdef1234567890',
  branchName: 'main',
  onConfirm: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('ResetModal', () => {
  it('default mode is mixed when no defaultMode prop', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onConfirm, onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('mixed');
    expect(onClose).toHaveBeenCalled();
  });

  it('respects defaultMode prop (soft)', async () => {
    const onConfirm = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onConfirm, defaultMode: 'soft' });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('soft');
  });

  it('respects defaultMode prop (hard)', async () => {
    const onConfirm = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onConfirm, defaultMode: 'hard' });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('hard');
  });

  it('switching mode via dropdown propagates to onConfirm', async () => {
    const onConfirm = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onConfirm });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const hardOpt = Array.from(opts).find(o => o.querySelector('.flag-badge')?.textContent === '--hard')!;
    await fireEvent.click(hardOpt);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('hard');
  });

  it('hard mode displays a warning message', async () => {
    const { container } = render(ResetModal, { ...baseProps, defaultMode: 'hard' });
    expect(container.querySelector('.warning-message')).not.toBeNull();
  });

  it('mixed mode does not display a warning message', async () => {
    const { container } = render(ResetModal, { ...baseProps, defaultMode: 'mixed' });
    expect(container.querySelector('.warning-message')).toBeNull();
  });

  it('renders short hash and branch name in the context card', () => {
    const { container } = render(ResetModal, baseProps);
    const text = container.querySelector('.modal-context-card')?.textContent ?? '';
    expect(text).toContain('abcdef1');
    expect(text).toContain('main');
  });

  it('omits the branch pill when branchName is not provided', () => {
    const { container } = render(ResetModal, { ...baseProps, branchName: undefined });
    const text = container.querySelector('.modal-context-card')?.textContent ?? '';
    expect(text).not.toContain('main');
    expect(text).toContain('abcdef1');
  });

  it('cancel fires onClose, not onConfirm', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onClose, onConfirm });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('initializes reset mode from defaultsStore', async () => {
    defaultsStore.current.reset = { mode: 'hard' };
    const onConfirm = vi.fn();
    const { container } = render(ResetModal, { ...baseProps, onConfirm });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('hard');
  });
});
