import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import PushTagModal from '../PushTagModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  tagName: 'v1.0.0',
  remotes: [{ name: 'origin' }],
  initialRemote: 'origin',
  onClose: vi.fn(),
  onPush: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('PushTagModal', () => {
  it('sends the initial remote when single-remote', async () => {
    const onPush = vi.fn();
    const { container } = render(PushTagModal, { ...baseProps, onPush });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPush).toHaveBeenCalledWith('origin');
  });

  it('shows a dropdown when there are multiple remotes', () => {
    const single = render(PushTagModal, baseProps);
    expect(single.container.querySelector('.color-select-btn')).toBeNull();
    single.unmount();

    const multi = render(PushTagModal, {
      ...baseProps,
      remotes: [{ name: 'origin' }, { name: 'fork' }],
    });
    expect(multi.container.querySelector('.color-select-btn')).not.toBeNull();
  });

  it('switching the remote in the dropdown changes the payload', async () => {
    const onPush = vi.fn();
    const { container } = render(PushTagModal, {
      ...baseProps,
      remotes: [{ name: 'origin' }, { name: 'fork' }],
      onPush,
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    await fireEvent.click(Array.from(opts).find(o => o.textContent?.includes('fork'))!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPush).toHaveBeenCalledWith('fork');
  });

  it('renders the tag name in the context card', () => {
    const { container } = render(PushTagModal, baseProps);
    expect(container.querySelector('.modal-context-card')?.textContent).toContain('v1.0.0');
  });

  it('cancel fires onClose, not onPush', async () => {
    const onClose = vi.fn();
    const onPush = vi.fn();
    const { container } = render(PushTagModal, { ...baseProps, onClose, onPush });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onPush).not.toHaveBeenCalled();
  });
});
