import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import MultiCherryPickModal from '../MultiCherryPickModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('MultiCherryPickModal', () => {
  it('lists each selected commit (short SHA)', () => {
    const { container } = render(MultiCherryPickModal, {
      commits: ['aaaaaaa1', 'bbbbbbb2'], branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    const pills = container.querySelectorAll('.modal-pill-text');
    expect(pills.length).toBe(2);
  });

  it('forwards noCommit to onCherryPick and suppresses pushAfter when noCommit is set', async () => {
    const onCherryPick = vi.fn();
    const { container } = render(MultiCherryPickModal, {
      commits: ['aaaaaaa1', 'bbbbbbb2'], branch: 'main',
      onClose: vi.fn(), onCherryPick,
    });
    const noCommit = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(noCommit);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCherryPick).toHaveBeenCalledWith({ noCommit: true, pushAfter: false });
  });

  it('forwards pushAfter when committing', async () => {
    const onCherryPick = vi.fn();
    const { container } = render(MultiCherryPickModal, {
      commits: ['aaaaaaa1', 'bbbbbbb2'], branch: 'main',
      onClose: vi.fn(), onCherryPick,
    });
    // First checkbox is noCommit (off); when off, the pushAfter checkbox shows.
    const pushAfter = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    await fireEvent.click(pushAfter);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCherryPick).toHaveBeenCalledWith({ noCommit: false, pushAfter: true });
  });
});
