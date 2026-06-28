import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import DirtyActionModal from '../DirtyActionModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => cleanup());

describe('DirtyActionModal', () => {
  it('renders the keep/stash/discard choices and the confirm label', async () => {
    const { container, getByText } = render(DirtyActionModal, {
      title: 'Interactive Rebase', confirmLabel: 'Rebase',
      onConfirm: vi.fn(), onClose: vi.fn(),
    });
    await tick();
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(2);
    expect(getByText('Rebase')).toBeTruthy();
  });

  it('confirms with the stash payload when stash is selected', async () => {
    const onConfirm = vi.fn();
    const { container, getByText } = render(DirtyActionModal, {
      title: 'Interactive Rebase', confirmLabel: 'Rebase',
      onConfirm, onClose: vi.fn(),
    });
    await tick();
    const stash = container.querySelector<HTMLInputElement>('input[value="stash"]')!;
    await fireEvent.change(stash);
    await fireEvent.click(getByText('Rebase'));
    expect(onConfirm).toHaveBeenCalledWith({ stash: true, stashUntracked: true });
  });
});
