import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import MergeBranchModal from '../MergeBranchModal.svelte';
import { i18n, t } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('MergeBranchModal', () => {
  it('on mount, posts predictConflicts with ours=target, theirs=source', () => {
    render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge: vi.fn() },
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const predict = posted.find(p => p.type === 'predictConflicts');
    expect(predict).toBeDefined();
    // For a merge, we apply `source` into `target`, so the prediction uses
    // ours=target, theirs=source.
    expect(predict!.payload!.ours).toBe('main');
    expect(predict!.payload!.theirs).toBe('feature/x');
  });

  it('default click sends noFf=false, ffOnly=false, squash=false', async () => {
    const onMerge = vi.fn();
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge },
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onMerge).toHaveBeenCalledWith({ noFf: false, ffOnly: false, squash: false, pushAfter: false, deleteSource: false });
  });

  it('selecting no-ff via the ColorSelect dropdown sets noFf=true, squash=false', async () => {
    const onMerge = vi.fn();
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge },
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const noFfOption = Array.from(container.querySelectorAll<HTMLButtonElement>('.color-select-option'))
      .find(o => o.textContent?.toLowerCase().includes('no fast'));
    expect(noFfOption).toBeDefined();
    await fireEvent.click(noFfOption!);
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onMerge).toHaveBeenCalledWith({ noFf: true, ffOnly: false, squash: false, pushAfter: false, deleteSource: false });
  });

  it('selecting squash sets squash=true, noFf=false (mutually exclusive with no-ff)', async () => {
    const onMerge = vi.fn();
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge },
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const squashOption = Array.from(container.querySelectorAll<HTMLButtonElement>('.color-select-option'))
      .find(o => o.textContent?.toLowerCase().includes('squash'));
    expect(squashOption).toBeDefined();
    await fireEvent.click(squashOption!);
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onMerge).toHaveBeenCalledWith({ noFf: false, ffOnly: false, squash: true, pushAfter: false, deleteSource: false });
  });

  it('forwards pushAfter flag to onMerge', async () => {
    const onMerge = vi.fn();
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge },
    });
    await fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onMerge).toHaveBeenCalledWith({ noFf: false, ffOnly: false, squash: false, pushAfter: true, deleteSource: false });
  });

  it('hides the delete-source checkbox unless canDeleteSource is true', () => {
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge: vi.fn() },
    });
    // Only the pushAfter checkbox is present by default.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it('forwards deleteSource flag when canDeleteSource is true', async () => {
    const onMerge = vi.fn();
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', canDeleteSource: true, onClose: vi.fn(), onMerge },
    });
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    await fireEvent.click(boxes[1]!); // deleteSource is the second checkbox
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onMerge).toHaveBeenCalledWith({ noFf: false, ffOnly: false, squash: false, pushAfter: false, deleteSource: true });
  });

  it('shows a deletion warning only when deleteSource is checked', async () => {
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', canDeleteSource: true, onClose: vi.fn(), onMerge: vi.fn() },
    });
    const warnText = t('merge.deleteSourceWarning').replace(/<[^>]*>/g, '');
    const hasWarn = () => Array.from(container.querySelectorAll('[role="alert"]')).some(el => el.textContent?.includes(warnText));
    expect(hasWarn()).toBe(false);
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await fireEvent.click(boxes[1]!); // deleteSource
    await tick();
    expect(hasWarn()).toBe(true);
  });

  it('warning banner appears for conflict prediction with hasConflict=true', async () => {
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge: vi.fn() },
    });
    const requestId = (globalThis.__postedMessages.find(m =>
      (m.data as { type: string }).type === 'predictConflicts',
    )!.data as { payload: { requestId: string } }).payload.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['a.ts'], requestId } },
    }));
    await tick();

    expect(container.querySelector('.conflict-status.is-warning')).not.toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();
  });

  it('initializes pushAfter checkbox from defaultsStore', async () => {
    defaultsStore.current.merge = { mode: 'no-ff', pushAfter: true, deleteSource: false };
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge: vi.fn() },
    });
    const pushAfterCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(pushAfterCheckbox.checked).toBe(true);
  });

  it('hovering the conflict warning lists the predicted conflict files', async () => {
    const { container } = render(MergeBranchModal, {
      props: { source: 'feature/x', target: 'main', onClose: vi.fn(), onMerge: vi.fn() },
    });
    const requestId = (globalThis.__postedMessages.find(m =>
      (m.data as { type: string }).type === 'predictConflicts',
    )!.data as { payload: { requestId: string } }).payload.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['src/a.ts', 'src/b.ts'], requestId } },
    }));
    await tick();

    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
    const items = container.querySelectorAll('.conflict-files-popover__item');
    expect(Array.from(items).map(i => i.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
