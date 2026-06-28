import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import AbortConfirmModal from '../AbortConfirmModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = { operation: 'rebase', onClose: vi.fn(), onConfirm: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });

describe('AbortConfirmModal', () => {
  it('confirm button fires onConfirm', async () => {
    const onConfirm = vi.fn();
    const { container } = render(AbortConfirmModal, { ...baseProps, onConfirm });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('cancel fires onClose only', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(AbortConfirmModal, { ...baseProps, onClose, onConfirm });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the operation name into the body', () => {
    const { container } = render(AbortConfirmModal, { ...baseProps, operation: 'merge' });
    expect(container.querySelector('.modal-desc')?.innerHTML).toContain('merge');
  });
});
