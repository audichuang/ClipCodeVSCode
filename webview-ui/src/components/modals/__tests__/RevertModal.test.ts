import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import RevertModal from '../RevertModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  commit: 'abcdef1234567890',
  branch: 'main',
  onClose: vi.fn(),
  onRevert: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('RevertModal — payload', () => {
  it('default click sends noCommit=false, pushAfter=false', async () => {
    const onRevert = vi.fn();
    const { container } = render(RevertModal, { ...baseProps, onRevert });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRevert).toHaveBeenCalledWith({ noCommit: false, pushAfter: false });
  });

  it('toggling --no-commit flips noCommit and hides pushAfter', async () => {
    const onRevert = vi.fn();
    const { container } = render(RevertModal, { ...baseProps, onRevert });
    const box = container.querySelector<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(box);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRevert).toHaveBeenCalledWith({ noCommit: true, pushAfter: false });
  });

  it('forwards pushAfter when noCommit is unchecked', async () => {
    const onRevert = vi.fn();
    const { container } = render(RevertModal, { ...baseProps, onRevert });
    const boxes = container.querySelectorAll<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    await fireEvent.click(boxes[1]!); // pushAfter
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRevert).toHaveBeenCalledWith({ noCommit: false, pushAfter: true });
  });

  it('renders short commit hash and branch in the context card', () => {
    const { container } = render(RevertModal, baseProps);
    const text = container.querySelector('.modal-context-card')?.textContent ?? '';
    expect(text).toContain('abcdef1');
    expect(text).toContain('main');
  });

  it('cancel fires onClose, not onRevert', async () => {
    const onClose = vi.fn();
    const onRevert = vi.fn();
    const { container } = render(RevertModal, { ...baseProps, onClose, onRevert });
    const buttons = container.querySelectorAll('button');
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onRevert).not.toHaveBeenCalled();
  });
});

describe('RevertModal — conflict prediction', () => {
  it('posts a predictConflicts request on mount', () => {
    globalThis.__postedMessages = [];
    render(RevertModal, baseProps);
    const predictMsg = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'predictConflicts'
    );
    expect(predictMsg).toBeDefined();
    const payload = (predictMsg!.data as { payload: Record<string, string> }).payload;
    expect(payload.ours).toBe('HEAD');
    expect(payload.theirs).toBe('abcdef1234567890^');
    expect(payload.mergeBase).toBe('abcdef1234567890');
    expect(typeof payload.requestId).toBe('string');
  });

  it('shows the checking spinner before a prediction arrives', () => {
    const { container } = render(RevertModal, baseProps);
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('renders the success state when prediction reports no conflict', async () => {
    const { container } = render(RevertModal, baseProps);
    const requestId = (globalThis.__postedMessages.at(-1)!.data as { payload: { requestId: string } }).payload.requestId;
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: false, files: [], requestId } },
    }));
    await waitFor(() => {
      expect(container.querySelector('.conflict-status.is-success')).not.toBeNull();
    });
  });

  it('renders the warning state when prediction reports conflicts', async () => {
    const { container } = render(RevertModal, baseProps);
    const requestId = (globalThis.__postedMessages.at(-1)!.data as { payload: { requestId: string } }).payload.requestId;
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['a.ts', 'b.ts'], requestId } },
    }));
    await waitFor(() => {
      expect(container.querySelector('.conflict-status.is-warning')).not.toBeNull();
    });
  });

  it('ignores messages with a mismatching requestId', async () => {
    const { container } = render(RevertModal, baseProps);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['x'], requestId: 'unrelated' } },
    }));
    // Still spinning
    expect(container.querySelector('.spinner')).not.toBeNull();
  });
});

describe('RevertModal — defaults store', () => {
  it('initializes pushAfter checkbox from defaultsStore', () => {
    defaultsStore.current.revert = { noCommit: false, pushAfter: true };
    const { container } = render(RevertModal, baseProps);
    const boxes = container.querySelectorAll<HTMLInputElement>('label.modal-checkbox input[type="checkbox"]');
    expect(boxes[1]!.checked).toBe(true);
  });
});
