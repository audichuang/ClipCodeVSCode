import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CherryPickModal from '../CherryPickModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('CherryPickModal', () => {
  it('on mount, posts predictConflicts with mergeBase = commit^', () => {
    render(CherryPickModal, {
      commit: 'abc1234',
      branch: 'main',
      onClose: vi.fn(),
      onCherryPick: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const predict = posted.find(p => p.type === 'predictConflicts');
    expect(predict).toBeDefined();
    expect(predict!.payload!.ours).toBe('HEAD');
    expect(predict!.payload!.theirs).toBe('abc1234');
    expect(predict!.payload!.mergeBase).toBe('abc1234^');
    expect(typeof predict!.payload!.requestId).toBe('string');
  });

  it('shows the checking-conflicts spinner before a response arrives', () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('updates the banner when a matching conflictPrediction response arrives', async () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const requestId = posted.find(p => p.type === 'predictConflicts')!.payload!.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['a.ts', 'b.ts'], requestId } },
    }));
    await tick();

    expect(container.querySelector('.spinner')).toBeNull();
    expect(container.querySelector('.conflict-status.is-warning')).not.toBeNull();
  });

  it('ignores responses with a non-matching requestId (stale from prior mount)', async () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['x'], requestId: 'stale-id' } },
    }));
    await tick();
    // Spinner should still be visible because the response was rejected.
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('falls back to no-conflict after 5s if no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(CherryPickModal, {
        commit: 'abc1234', branch: 'main',
        onClose: vi.fn(), onCherryPick: vi.fn(),
      });
      expect(container.querySelector('.spinner')).not.toBeNull();
      vi.advanceTimersByTime(5000);
      await tick();
      // Spinner gone, success banner shown so the user can still proceed.
      expect(container.querySelector('.spinner')).toBeNull();
      expect(container.querySelector('.conflict-status.is-success')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the noCommit checkbox state to onCherryPick (hiding pushAfter)', async () => {
    const onCherryPick = vi.fn();
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick,
    });
    const checkbox = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(checkbox); // noCommit = true
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCherryPick).toHaveBeenCalledWith({ noCommit: true, pushAfter: false });
  });

  it('forwards pushAfter when noCommit is unchecked', async () => {
    const onCherryPick = vi.fn();
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick,
    });
    // noCommit is off by default, so the pushAfter checkbox is shown second.
    const boxes = container.querySelectorAll<HTMLInputElement>('.modal-checkbox input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    await fireEvent.click(boxes[1]!); // pushAfter
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCherryPick).toHaveBeenCalledWith({ noCommit: false, pushAfter: true });
  });

  it('hides the pushAfter checkbox when noCommit is checked', async () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    const noCommit = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(noCommit);
    await tick();
    expect(container.querySelectorAll('.modal-checkbox input[type="checkbox"]')).toHaveLength(1);
  });

  it('initializes pushAfter checkbox from defaultsStore', () => {
    defaultsStore.current.cherryPick = { noCommit: false, pushAfter: true };
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    const boxes = container.querySelectorAll<HTMLInputElement>('.modal-checkbox input[type="checkbox"]');
    expect(boxes[1]!.checked).toBe(true);
  });
});
