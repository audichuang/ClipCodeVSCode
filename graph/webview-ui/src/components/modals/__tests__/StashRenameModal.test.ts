import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import StashRenameModal from '../StashRenameModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  index: 2,
  initialMessage: 'WIP on branch',
  onClose: vi.fn(),
  onRename: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('StashRenameModal', () => {
  it('prepopulates the input with initialMessage', () => {
    const { container } = render(StashRenameModal, baseProps);
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    expect(input.value).toBe('WIP on branch');
  });

  it('submits the edited message', async () => {
    const onRename = vi.fn();
    const { container } = render(StashRenameModal, { ...baseProps, onRename });
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    await fireEvent.input(input, { target: { value: 'new label' } });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRename).toHaveBeenCalledWith('new label');
  });

  it('Enter key submits the message', async () => {
    const onRename = vi.fn();
    const { container } = render(StashRenameModal, { ...baseProps, onRename });
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    await fireEvent.input(input, { target: { value: 'pressed enter' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('pressed enter');
  });

  it('disables the primary button when the message is blank', async () => {
    const onRename = vi.fn();
    const { container } = render(StashRenameModal, { ...baseProps, initialMessage: '   ', onRename });
    const btn = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows the stash@{index} reference in the context card', () => {
    const { container } = render(StashRenameModal, baseProps);
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('stash@{2}');
  });
});
