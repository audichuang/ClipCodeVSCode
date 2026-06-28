import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import PushModal from '../PushModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = {
  branchName: 'main',
  hasUpstream: true,
  upstream: 'origin/main',
  remotes: [{ name: 'origin' }],
  initialRemote: 'origin',
  onClose: vi.fn(),
  onPush: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
});

describe('PushModal — payload composition', () => {
  it('default click sends forceMode=none, setUpstream=true, no allTags', async () => {
    const onPush = vi.fn();
    const { container } = render(PushModal, { ...baseProps, onPush });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPush).toHaveBeenCalledWith({
      forceMode: 'none',
      setUpstream: true,
      remote: 'origin',
      allTags: false,
    });
  });

  it('toggling allTags propagates into the payload', async () => {
    const onPush = vi.fn();
    const { container } = render(PushModal, { ...baseProps, onPush });
    // Find the allTags checkbox by adjacent label text.
    const labels = container.querySelectorAll('label.modal-checkbox');
    let allTagsBox: HTMLInputElement | null = null;
    for (const lbl of labels) {
      if (lbl.textContent?.toLowerCase().includes('all tags')) {
        allTagsBox = lbl.querySelector('input[type="checkbox"]');
        break;
      }
    }
    expect(allTagsBox).not.toBeNull();
    await fireEvent.click(allTagsBox!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPush.mock.calls[0][0].allTags).toBe(true);
  });
});

describe('PushModal — force mode XOR', () => {
  function findForceBoxes(container: HTMLElement) {
    // force-with-lease and force are sibling labels — distinguish by the
    // adjacent --flag badge text rather than label copy (which is i18n'd).
    const labels = container.querySelectorAll('label.modal-checkbox');
    let withLease: HTMLInputElement | null = null;
    let force: HTMLInputElement | null = null;
    for (const lbl of labels) {
      const flag = lbl.querySelector('.modal-flag-badge')?.textContent ?? '';
      const box = lbl.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (flag === '--force-with-lease') withLease = box;
      else if (flag === '--force') force = box;
    }
    return { withLease, force };
  }

  it('ticking --force-with-lease unticks --force (mutually exclusive)', async () => {
    const onPush = vi.fn();
    const { container } = render(PushModal, { ...baseProps, onPush });
    const { withLease, force } = findForceBoxes(container);
    expect(withLease).not.toBeNull();
    expect(force).not.toBeNull();

    await fireEvent.click(force!);
    await fireEvent.click(withLease!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);

    expect(onPush.mock.calls[0][0].forceMode).toBe('with-lease');
  });

  it('clicking the same force option twice clears it (toggle off)', async () => {
    const onPush = vi.fn();
    const { container } = render(PushModal, { ...baseProps, onPush });
    const { withLease } = findForceBoxes(container);
    await fireEvent.click(withLease!);
    await fireEvent.click(withLease!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onPush.mock.calls[0][0].forceMode).toBe('none');
  });

  it('warning panel appears for --force and changes wording vs --force-with-lease', async () => {
    const { container } = render(PushModal, { ...baseProps });
    const { withLease, force } = findForceBoxes(container);
    // No warning initially.
    expect(container.querySelector('.modal-warning')).toBeNull();

    await fireEvent.click(withLease!);
    const leaseWarning = container.querySelector('.modal-warning')?.textContent ?? '';
    expect(leaseWarning.length).toBeGreaterThan(0);

    // Switching to --force replaces the warning with the harsher one.
    await fireEvent.click(force!);
    const forceWarning = container.querySelector('.modal-warning')?.textContent ?? '';
    expect(forceWarning.length).toBeGreaterThan(0);
    expect(forceWarning).not.toBe(leaseWarning);
  });
});

describe('PushModal — initializes from defaultsStore', () => {
  afterEach(() => {
    defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS);
  });

  it('force-with-lease checkbox is checked when store sets force=with-lease', () => {
    defaultsStore.current.push = { force: 'with-lease', setUpstream: true, allTags: false };
    const { container } = render(PushModal, { ...baseProps });
    const labels = container.querySelectorAll('label.modal-checkbox');
    let withLeaseBox: HTMLInputElement | null = null;
    for (const lbl of labels) {
      if (lbl.querySelector('.modal-flag-badge')?.textContent === '--force-with-lease') {
        withLeaseBox = lbl.querySelector<HTMLInputElement>('input[type="checkbox"]');
        break;
      }
    }
    expect(withLeaseBox).not.toBeNull();
    expect(withLeaseBox!.checked).toBe(true);
  });
});

describe('PushModal — setUpstream visibility', () => {
  it('shows the "create tracking" checkbox only when hasUpstream=false', () => {
    const withUpstream = render(PushModal, { ...baseProps, hasUpstream: true });
    const beforeLabels = Array.from(withUpstream.container.querySelectorAll('label.modal-checkbox'))
      .map(l => l.textContent ?? '');
    expect(beforeLabels.some(t => /tracking/i.test(t))).toBe(false);
    withUpstream.unmount();

    const without = render(PushModal, { ...baseProps, hasUpstream: false });
    const labels = Array.from(without.container.querySelectorAll('label.modal-checkbox'))
      .map(l => l.textContent ?? '');
    expect(labels.some(t => /tracking/i.test(t))).toBe(true);
  });
});
