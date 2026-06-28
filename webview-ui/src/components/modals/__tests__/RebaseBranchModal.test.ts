import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import RebaseBranchModal from '../RebaseBranchModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('RebaseBranchModal', () => {
  it('on mount, posts predictConflicts with mode=rebase and ours=branch, theirs=onto', () => {
    render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const predict = posted.find(p => p.type === 'predictConflicts');
    expect(predict).toBeDefined();
    expect(predict!.payload!.ours).toBe('topic');
    expect(predict!.payload!.theirs).toBe('main');
    expect(predict!.payload!.mode).toBe('rebase');
  });

  it('shows spinner before conflict response arrives', () => {
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('switches to success class when prediction reports no conflict', async () => {
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    const requestId = (globalThis.__postedMessages.find(m =>
      (m.data as { type: string }).type === 'predictConflicts',
    )!.data as { payload: { requestId: string } }).payload.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: false, files: [], requestId } },
    }));
    await tick();

    expect(container.querySelector('.conflict-status.is-success')).not.toBeNull();
  });

  it('forwards autostash flag to onRebase', async () => {
    const onRebase = vi.fn();
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase,
    });
    const autostash = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!;
    await fireEvent.click(autostash);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRebase).toHaveBeenCalledWith({ autostash: true, pushAfter: false });
  });

  it('forwards pushAfter flag to onRebase', async () => {
    const onRebase = vi.fn();
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase,
    });
    const pushAfter = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    await fireEvent.click(pushAfter);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRebase).toHaveBeenCalledWith({ autostash: false, pushAfter: true });
  });

  it('initializes autostash and pushAfter from defaultsStore', async () => {
    defaultsStore.current.rebase = { autostash: true, pushAfter: true };
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes[0]!.checked).toBe(true);  // autostash
    expect(checkboxes[1]!.checked).toBe(true);  // pushAfter
  });
});
