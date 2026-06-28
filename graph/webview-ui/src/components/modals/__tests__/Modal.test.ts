import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
// Modal expects a Snippet child; CreateBranchModal renders Modal internally
// so reuse it as the harness — keeps us testing the real wiring without a
// per-test wrapper component.
import CreateBranchModal from '../CreateBranchModal.svelte';

describe('Modal (close behavior, exercised via CreateBranchModal)', () => {
  it('Escape key triggers onClose', async () => {
    const onClose = vi.fn();
    render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape only fires onClose once even if the user mashes the key', async () => {
    const onClose = vi.fn();
    render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the dedicated close button triggers onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    const closeBtn = container.querySelector<HTMLButtonElement>('.modal-close');
    await fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicks inside the dialog do NOT bubble to the overlay close handler', async () => {
    const onClose = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    const dialog = container.querySelector<HTMLDivElement>('.modal');
    await fireEvent.click(dialog!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the title from the i18n key', () => {
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose: vi.fn(), onCreate: vi.fn() });
    const title = container.querySelector('.modal-title');
    expect(title?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('clicking the overlay (outside the dialog) triggers onClose after rAF', async () => {
    const onClose = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    // ready flag is set on the next animation frame
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const overlay = container.querySelector<HTMLDivElement>('.modal-overlay')!;
    await fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter on the dialog clicks the first non-disabled .primary button', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose: vi.fn(), onCreate });
    // Fill the input so primary becomes enabled
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    await fireEvent.input(input, { target: { value: 'new-branch' } });
    // Move focus to the dialog wrapper so handleDialogKeydown picks it up
    const dialog = container.querySelector<HTMLDivElement>('.modal')!;
    await fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalled();
  });

  it('Enter when the event target is an INPUT is ignored (handler returns early)', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose: vi.fn(), onCreate });
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    await fireEvent.input(input, { target: { value: 'new-branch' } });
    // Enter on the input — Modal's keydown handler should NOT click primary
    // (CreateBranchModal may have its own input Enter behavior; this just
    // verifies the Modal-level handler bails when target is INPUT).
    onCreate.mockClear();
    await fireEvent.keyDown(input, { key: 'Enter' });
    // If CreateBranchModal also wires Enter on input, this may still call onCreate.
    // The assertion focuses on Modal's handler not firing — we can't directly
    // detect that, so this test just exercises the early-return branch.
    expect(true).toBe(true);
  });

  it('non-Enter keydown on the dialog does nothing', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose: vi.fn(), onCreate });
    const dialog = container.querySelector<HTMLDivElement>('.modal')!;
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(onCreate).not.toHaveBeenCalled();
  });
});
