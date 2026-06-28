import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import StashRestoreModal from '../StashRestoreModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const base = {
  index: 0,
  message: 'WIP',
  paths: ['src/a.ts', 'src/b.ts'],
  onClose: vi.fn(),
  onRestore: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('StashRestoreModal', () => {
  it('lists each path to restore', () => {
    const { getByText } = render(StashRestoreModal, { ...base });
    expect(getByText('src/a.ts')).toBeTruthy();
    expect(getByText('src/b.ts')).toBeTruthy();
  });

  it('calls onRestore when the restore button is clicked', async () => {
    const onRestore = vi.fn();
    const { container } = render(StashRestoreModal, { ...base, onRestore });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('calls onClose when cancel is clicked, not onRestore', async () => {
    const onClose = vi.fn();
    const onRestore = vi.fn();
    const { container } = render(StashRestoreModal, { ...base, onClose, onRestore });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('falls back to stash@{index} when message is empty', () => {
    const { container } = render(StashRestoreModal, { ...base, message: '' });
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('stash@{0}');
  });

  it('uses the message when provided', () => {
    const { container } = render(StashRestoreModal, { ...base });
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('WIP');
  });
});
