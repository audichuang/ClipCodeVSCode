import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import PullModal from '../PullModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  upstream: 'origin/main',
  currentBranch: 'main',
  onClose: vi.fn(),
  onPull: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

function findFlagBox(container: HTMLElement, flag: string): HTMLInputElement {
  const labels = container.querySelectorAll('label.modal-checkbox');
  for (const lbl of labels) {
    if (lbl.querySelector('.modal-flag-badge')?.textContent === flag) {
      return lbl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    }
  }
  throw new Error(`flag ${flag} not found`);
}

describe('PullModal — payload composition', () => {
  it('defaults to rebase=true, stash=false', async () => {
    const onPull = vi.fn();
    const { container } = render(PullModal, { ...baseProps, onPull });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPull).toHaveBeenCalledWith({ rebase: true, stash: false });
  });

  it('toggling --rebase off flips the payload', async () => {
    const onPull = vi.fn();
    const { container } = render(PullModal, { ...baseProps, onPull });
    await fireEvent.click(findFlagBox(container, '--rebase'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPull.mock.calls[0][0].rebase).toBe(false);
  });

  it('toggling --autostash on flips the payload', async () => {
    const onPull = vi.fn();
    const { container } = render(PullModal, { ...baseProps, onPull });
    await fireEvent.click(findFlagBox(container, '--autostash'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPull.mock.calls[0][0].stash).toBe(true);
  });

  it('cancel button fires onClose, not onPull', async () => {
    const onClose = vi.fn();
    const onPull = vi.fn();
    const { container } = render(PullModal, { ...baseProps, onClose, onPull });
    const buttons = container.querySelectorAll('button');
    // cancel is the first button in form-actions; primary is second
    await fireEvent.click(buttons[buttons.length - 2]);
    expect(onClose).toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
  });
});

describe('PullModal — initializes from defaultsStore', () => {
  afterEach(() => {
    defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS);
  });

  it('rebase checkbox is unchecked and stash checkbox is checked when store sets rebase=false, stash=true', () => {
    defaultsStore.current.pull = { rebase: false, stash: true };
    const { container } = render(PullModal, { ...baseProps });
    const rebaseBox = findFlagBox(container, '--rebase');
    const stashBox = findFlagBox(container, '--autostash');
    expect(rebaseBox.checked).toBe(false);
    expect(stashBox.checked).toBe(true);
  });
});

describe('PullModal — context card', () => {
  it('renders the upstream and current branch pills', () => {
    const { container } = render(PullModal, baseProps);
    const text = container.querySelector('.modal-context-card')?.textContent ?? '';
    expect(text).toContain('origin/main');
    expect(text).toContain('main');
  });
});
