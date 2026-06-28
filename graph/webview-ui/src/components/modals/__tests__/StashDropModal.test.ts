import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import StashDropModal from '../StashDropModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  message: 'WIP debugging',
  onClose: vi.fn(),
  onDrop: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('StashDropModal', () => {
  it('renders the stash message in the confirmation', () => {
    const { container } = render(StashDropModal, baseProps);
    expect(container.textContent).toContain('WIP debugging');
  });

  it('drop button fires onDrop', async () => {
    const onDrop = vi.fn();
    const { container } = render(StashDropModal, { ...baseProps, onDrop });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDrop).toHaveBeenCalled();
  });

  it('cancel fires onClose, not onDrop', async () => {
    const onClose = vi.fn();
    const onDrop = vi.fn();
    const { container } = render(StashDropModal, { ...baseProps, onClose, onDrop });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });
});
