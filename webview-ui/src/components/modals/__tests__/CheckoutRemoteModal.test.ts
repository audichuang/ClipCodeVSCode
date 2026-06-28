import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CheckoutRemoteModal from '../CheckoutRemoteModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('CheckoutRemoteModal', () => {
  it('seeds the local name field from defaultLocalName', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/feature/x',
      defaultLocalName: 'feature/x',
      dirty: false,
      onClose: vi.fn(),
      onCheckout: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>('#checkout-local-name')!;
    expect(input.value).toBe('feature/x');
  });

  it('hides the dirty radio group when dirty=false', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: false,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });

  it('shows three dirty options when dirty=true', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: true,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(3);
  });

  it('disables submit when local name is blank', async () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: '', dirty: false,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('initializes dirtyOption from defaultsStore.current.checkoutRemote.dirty', async () => {
    defaultsStore.current.checkoutRemote = { dirty: 'stash' };
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: true,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    const stashRadio = container.querySelector<HTMLInputElement>('input[type="radio"][value="stash"]')!;
    expect(stashRadio.checked).toBe(true);
  });

  it('ignores the dirty default when the working tree is clean (passes keep)', async () => {
    defaultsStore.current.checkoutRemote = { dirty: 'discard' };
    const onCheckout = vi.fn();
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: false,
      onClose: vi.fn(), onCheckout,
    });
    // No dirty radios are rendered when the working tree is clean.
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('x', 'keep');
  });

  it('forwards trimmed local name and chosen dirty option', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: '  feature/x  ', dirty: true,
      onClose: vi.fn(), onCheckout,
    });
    const stash = container.querySelector<HTMLInputElement>('input[type="radio"][value="stash"]')!;
    await fireEvent.click(stash);
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', 'stash');
  });
});
