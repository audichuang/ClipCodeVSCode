import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import DeleteRemoteBranchModal from '../DeleteRemoteBranchModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = { remote: 'origin', branchName: 'feat', onClose: vi.fn(), onDelete: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });

describe('DeleteRemoteBranchModal', () => {
  it('renders remote/branch combination in the description', () => {
    const { container } = render(DeleteRemoteBranchModal, baseProps);
    expect(container.querySelector('.modal-desc')?.innerHTML).toContain('origin/feat');
  });

  it('delete fires onDelete', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteRemoteBranchModal, { ...baseProps, onDelete });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalled();
  });

  it('cancel fires onClose, not onDelete', async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(DeleteRemoteBranchModal, { ...baseProps, onClose, onDelete });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
