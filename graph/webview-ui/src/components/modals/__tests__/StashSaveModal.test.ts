import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import StashSaveModal from '../StashSaveModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  onClose: vi.fn(),
  onSave: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

function findFlag(container: HTMLElement, flag: string): HTMLInputElement {
  const labels = container.querySelectorAll('label.modal-checkbox');
  for (const lbl of labels) {
    if (lbl.querySelector('.modal-flag-badge')?.textContent === flag) {
      return lbl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    }
  }
  throw new Error(`flag ${flag} not found`);
}

describe('StashSaveModal', () => {
  it('defaults: empty message, includeUntracked=true, keepIndex=false', async () => {
    const onSave = vi.fn();
    const { container } = render(StashSaveModal, { ...baseProps, onSave });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onSave).toHaveBeenCalledWith('', true, false);
  });

  it('Enter in the input submits the form', async () => {
    const onSave = vi.fn();
    const { container } = render(StashSaveModal, { ...baseProps, onSave });
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    await fireEvent.input(input, { target: { value: 'wip msg' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('wip msg', true, false);
  });

  it('toggling --include-untracked flips that flag', async () => {
    const onSave = vi.fn();
    const { container } = render(StashSaveModal, { ...baseProps, onSave });
    await fireEvent.click(findFlag(container, '--include-untracked'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onSave).toHaveBeenCalledWith('', false, false);
  });

  it('toggling --keep-index flips that flag', async () => {
    const onSave = vi.fn();
    const { container } = render(StashSaveModal, { ...baseProps, onSave });
    await fireEvent.click(findFlag(container, '--keep-index'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onSave).toHaveBeenCalledWith('', true, true);
  });

  it('cancel fires onClose, not onSave', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const { container } = render(StashSaveModal, { ...baseProps, onClose, onSave });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('initializes includeUntracked and keepIndex from defaultsStore', () => {
    defaultsStore.current.stashSave = { includeUntracked: false, keepIndex: true };
    const { container } = render(StashSaveModal, baseProps);
    const includeUntrackedCheckbox = findFlag(container, '--include-untracked');
    const keepIndexCheckbox = findFlag(container, '--keep-index');
    expect(includeUntrackedCheckbox.checked).toBe(false);
    expect(keepIndexCheckbox.checked).toBe(true);
  });
});
