import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import FetchModal from '../FetchModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  remotes: [{ name: 'origin' }, { name: 'upstream' }],
  initialRemote: 'origin',
  onClose: vi.fn(),
  onFetch: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('FetchModal — initializes from defaultsStore', () => {
  afterEach(() => {
    defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS);
  });

  it('all-remotes checkbox is checked when store sets allRemotes=true', () => {
    defaultsStore.current.fetch = { allRemotes: true };
    const { container } = render(FetchModal, { ...baseProps });
    const box = container.querySelector<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
  });
});

describe('FetchModal — payload', () => {
  it('default fetch sends the initial remote', async () => {
    const onFetch = vi.fn();
    const { container } = render(FetchModal, { ...baseProps, onFetch });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onFetch).toHaveBeenCalledWith('origin');
  });

  it('checking "all remotes" sends undefined to mean --all', async () => {
    const onFetch = vi.fn();
    const { container } = render(FetchModal, { ...baseProps, onFetch });
    const box = container.querySelector<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(box);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onFetch).toHaveBeenCalledWith(undefined);
  });

  it('selecting a different remote in the dropdown changes the payload', async () => {
    const onFetch = vi.fn();
    const { container } = render(FetchModal, { ...baseProps, onFetch });
    // Open ColorSelect dropdown
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    // Click the "upstream" option
    const options = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const upstreamOpt = Array.from(options).find(o => o.textContent?.includes('upstream'))!;
    await fireEvent.click(upstreamOpt);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onFetch).toHaveBeenCalledWith('upstream');
  });

  it('cancel button fires onClose, not onFetch', async () => {
    const onClose = vi.fn();
    const onFetch = vi.fn();
    const { container } = render(FetchModal, { ...baseProps, onClose, onFetch });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onFetch).not.toHaveBeenCalled();
  });
});
