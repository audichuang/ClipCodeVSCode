import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import RebaseTargetModal from '../RebaseTargetModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => cleanup());

describe('RebaseTargetModal', () => {
  it('shows no branch picker and no shared warning for a single candidate', async () => {
    const { container } = render(RebaseTargetModal, {
      branches: ['feature'], currentBranch: 'main', base: 'r',
      onConfirm: vi.fn(), onClose: vi.fn(),
    });
    await tick();
    expect(container.textContent).not.toContain('Select branch to rebase');
    expect(container.textContent).not.toContain('belong to multiple branches');
  });

  it('shows the branch picker and shared-history warning for multiple candidates', async () => {
    const { container } = render(RebaseTargetModal, {
      branches: ['feature', 'hotfix'], currentBranch: 'main', base: 'r',
      onConfirm: vi.fn(), onClose: vi.fn(),
    });
    await tick();
    expect(container.textContent).toContain('Select branch to rebase');
    expect(container.textContent).toContain('belong to multiple branches');
  });

  it('confirms with the selected branch and empty payload on a clean tree', async () => {
    const onConfirm = vi.fn();
    const { container } = render(RebaseTargetModal, {
      branches: ['feature'], currentBranch: 'main', base: 'r',
      onConfirm, onClose: vi.fn(),
    });
    await tick();
    // Title and button both read "Checkout"; click the primary confirm button.
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onConfirm).toHaveBeenCalledWith('feature', {});
  });
});
