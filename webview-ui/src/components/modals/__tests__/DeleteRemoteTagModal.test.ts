import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import DeleteRemoteTagModal from '../DeleteRemoteTagModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = { tagName: 'v9.9', onClose: vi.fn(), onDelete: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });

describe('DeleteRemoteTagModal', () => {
  it('renders tag name in the description', () => {
    const { container } = render(DeleteRemoteTagModal, baseProps);
    expect(container.querySelector('.modal-desc')?.innerHTML).toContain('v9.9');
  });

  it('delete fires onDelete', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteRemoteTagModal, { ...baseProps, onDelete });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalled();
  });

  it('cancel fires onClose, not onDelete', async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(DeleteRemoteTagModal, { ...baseProps, onClose, onDelete });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
