import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import RenameBranchModal from '../RenameBranchModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

describe('RenameBranchModal', () => {
  it('starts with submit disabled (name === oldName)', () => {
    const { container } = render(RenameBranchModal, {
      oldName: 'feature/x',
      onClose: vi.fn(),
      onRename: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(submit.disabled).toBe(true);
  });

  it('enables submit when the user changes the name to something valid', async () => {
    const { container } = render(RenameBranchModal, {
      oldName: 'feature/x',
      onClose: vi.fn(),
      onRename: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>('#rename-branch-input')!;
    await fireEvent.input(input, { target: { value: 'feature/y' } });
    await tick();
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
  });

  it('disables submit and shows warning when the name has invalid characters', async () => {
    const { container } = render(RenameBranchModal, {
      oldName: 'feature/x',
      onClose: vi.fn(),
      onRename: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>('#rename-branch-input')!;
    await fireEvent.input(input, { target: { value: 'bad:name' } });
    await tick();
    expect(container.querySelector('.modal-warning')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('disables submit when the name is blanked out entirely', async () => {
    const { container } = render(RenameBranchModal, {
      oldName: 'feature/x',
      onClose: vi.fn(),
      onRename: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>('#rename-branch-input')!;
    await fireEvent.input(input, { target: { value: '   ' } });
    await tick();
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('calls onRename with the new (untrimmed) value on Enter', async () => {
    const onRename = vi.fn();
    const { container } = render(RenameBranchModal, {
      oldName: 'feature/x',
      onClose: vi.fn(),
      onRename,
    });
    const input = container.querySelector<HTMLInputElement>('#rename-branch-input')!;
    await fireEvent.input(input, { target: { value: 'feature/y' } });
    await tick();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('feature/y');
  });
});
