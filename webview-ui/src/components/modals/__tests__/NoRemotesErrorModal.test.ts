import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import NoRemotesErrorModal from '../NoRemotesErrorModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = { onClose: vi.fn(), onAddRemote: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });

describe('NoRemotesErrorModal', () => {
  it('primary button fires onAddRemote', async () => {
    const onAddRemote = vi.fn();
    const { container } = render(NoRemotesErrorModal, { ...baseProps, onAddRemote });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onAddRemote).toHaveBeenCalled();
  });

  it('cancel fires onClose, not onAddRemote', async () => {
    const onClose = vi.fn();
    const onAddRemote = vi.fn();
    const { container } = render(NoRemotesErrorModal, { ...baseProps, onClose, onAddRemote });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onAddRemote).not.toHaveBeenCalled();
  });
});
