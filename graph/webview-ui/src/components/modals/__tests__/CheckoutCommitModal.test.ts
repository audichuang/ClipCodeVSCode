import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CheckoutCommitModal from '../CheckoutCommitModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

// Helper: respond to the dirty-state request the modal fires on mount. The
// modal awaits this before rendering the dirty-handling radio group, so most
// tests must drive the response explicitly.
function respondToDirtyCheck(dirty: boolean) {
  const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
  const req = posted.find(p => p.type === 'checkDirty');
  if (!req) return;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dirtyState', payload: { requestId: req.payload!.requestId, dirty } },
  }));
}

describe('CheckoutCommitModal — target selection', () => {
  it('passes the chosen branch to onCheckout when multiple linked branches exist', async () => {
    const onCheckout = vi.fn();
    const onClose = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234',
      linkedBranches: ['feature/x', 'feature/y'],
      currentBranch: 'main',
      onCheckout, onClose,
    });
    respondToDirtyCheck(false);
    await tick();

    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    // Default selectedBranch = first item of (linkedBranches \ currentBranch).
    expect(onCheckout).toHaveBeenCalledWith('feature/x', {});
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters out the current branch from selectable branches', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234',
      linkedBranches: ['main', 'develop'],
      currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(false);
    await tick();

    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    // 'main' filtered out → selectedBranch = 'develop'.
    expect(onCheckout).toHaveBeenCalledWith('develop', {});
  });

  it('falls back to remote/branch ref when only linked remote branches exist', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234',
      linkedBranches: [],
      linkedRemoteBranches: [{ remote: 'origin', name: 'feature/x' }],
      currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(false);
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('origin/feature/x', {});
  });

  it('falls back to the commit hash (detached HEAD warning) when no branches link to it', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234',
      linkedBranches: [],
      linkedRemoteBranches: [],
      currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(false);
    await tick();
    expect(container.querySelector('.modal-warning')).not.toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('abc1234', {});
  });
});

describe('CheckoutCommitModal — defaults store', () => {
  it('initializes dirtyOption from defaultsStore.current.checkout.dirty', async () => {
    defaultsStore.current.checkout = { dirty: 'stash' };
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234', linkedBranches: ['feature/x'], currentBranch: 'main',
      onCheckout: vi.fn(), onClose: vi.fn(),
    });
    respondToDirtyCheck(true);
    await tick();
    const stashRadio = container.querySelector<HTMLInputElement>('input[type="radio"][value="stash"]')!;
    expect(stashRadio.checked).toBe(true);
  });
});

describe('CheckoutCommitModal — dirty payload', () => {
  it('"keep" sends { merge: true }', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234', linkedBranches: ['feature/x'], currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(true);
    await tick();
    // 'keep' is the initial radio value, so just submit.
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', { merge: true });
  });

  it('"stash" sends { stash: true, stashUntracked: true }', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234', linkedBranches: ['feature/x'], currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(true);
    await tick();
    const stash = container.querySelector<HTMLInputElement>('input[type="radio"][value="stash"]')!;
    await fireEvent.click(stash);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', { stash: true, stashUntracked: true });
  });

  it('"discard" sends { force: true, clean: true } and shows the destructive warning', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234', linkedBranches: ['feature/x'], currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(true);
    await tick();
    const discard = container.querySelector<HTMLInputElement>('input[type="radio"][value="discard"]')!;
    await fireEvent.click(discard);
    await tick();
    expect(container.querySelector('.modal-warning')).not.toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', { force: true, clean: true });
  });

  it('switching branch via the ColorSelect dropdown propagates to onCheckout', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234',
      linkedBranches: ['feature/x', 'feature/y', 'feature/z'],
      currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(false);
    await tick();
    // Open the branch picker and pick "feature/z"
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const z = Array.from(opts).find(o => o.textContent?.includes('feature/z'))!;
    await fireEvent.click(z);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/z', {});
  });

  it('omits dirty payload entirely (empty object) when working tree is clean', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutCommitModal, {
      hash: 'abc1234', linkedBranches: ['feature/x'], currentBranch: 'main',
      onCheckout, onClose: vi.fn(),
    });
    respondToDirtyCheck(false);
    await tick();
    // No radio group rendered.
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', {});
  });
});
