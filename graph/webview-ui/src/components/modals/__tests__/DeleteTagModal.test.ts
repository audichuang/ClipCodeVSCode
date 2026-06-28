import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import DeleteTagModal from '../DeleteTagModal.svelte';
import { i18n, t } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

const baseProps = { tagName: 'v1.0', onClose: vi.fn(), onDelete: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('DeleteTagModal', () => {
  it('renders the tag name in the description', () => {
    const { container } = render(DeleteTagModal, baseProps);
    expect(container.querySelector('.modal-desc')?.innerHTML).toContain('v1.0');
  });

  it('passes deleteRemote=false by default', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, onDelete });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false);
  });

  it('shows the remote checkbox only when hasRemote=true', () => {
    const noRemote = render(DeleteTagModal, baseProps);
    expect(noRemote.container.querySelector('.modal-checkbox')).toBeNull();
    noRemote.unmount();

    const hasRemote = render(DeleteTagModal, { ...baseProps, hasRemote: true });
    expect(hasRemote.container.querySelector('.modal-checkbox')).not.toBeNull();
  });

  it('checking the remote box propagates deleteRemote=true', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, hasRemote: true, onDelete });
    await fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it('cancel fires onClose, not onDelete', async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, onClose, onDelete });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows no destructive-default banner when defaults are false', () => {
    const { container } = render(DeleteTagModal, { ...baseProps, hasRemote: true });
    const bannerText = t('deleteTag.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
  });

  it('initializes deleteRemote from store, checkbox checked and banner shown when deleteRemote default is true', () => {
    defaultsStore.current.deleteTag = { deleteRemote: true };
    const { container } = render(DeleteTagModal, { ...baseProps, hasRemote: true });
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    const bannerText = t('deleteTag.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.some(el => el.textContent?.includes(bannerText))).toBe(true);
  });

  it('ignores the deleteRemote default when the tag has no remote (no warning, passes false)', async () => {
    defaultsStore.current.deleteTag = { deleteRemote: true };
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, hasRemote: false, onDelete });
    const bannerText = t('deleteTag.deleteRemoteWarning').replace(/<[^>]*>/g, '');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.every(el => !el.textContent?.includes(bannerText))).toBe(true);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false);
  });
});
