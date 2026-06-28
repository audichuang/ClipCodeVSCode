import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import AmendModal from '../AmendModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';

beforeEach(() => i18n.setLocale('en'));
afterEach(() => { cleanup(); defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

const base = {
  hash: 'abcdef1234567890',
  subject: 'fix: thing',
  message: 'fix: thing\n\nbody line',
  isPushed: false,
};

describe('AmendModal', () => {
  it('keeps the message by default and makes the textarea readonly', () => {
    const { container } = render(AmendModal, { ...base, onClose: () => {}, onAmend: () => {} });
    const textarea = container.querySelector<HTMLTextAreaElement>('#amend-message')!;
    // readonly (not disabled) so a long kept message stays scrollable/readable.
    expect(textarea.readOnly).toBe(true);
  });

  it('makes the textarea editable when "keep message" is unchecked', async () => {
    const { container } = render(AmendModal, { ...base, onClose: () => {}, onAmend: () => {} });
    const keep = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(keep); // uncheck keepMessage
    const textarea = container.querySelector<HTMLTextAreaElement>('#amend-message')!;
    expect(textarea.readOnly).toBe(false);
  });

  it('amends keeping the message (no message in payload)', async () => {
    const onAmend = vi.fn();
    const { getByText } = render(AmendModal, { ...base, onClose: () => {}, onAmend });
    await fireEvent.click(getByText('Amend'));
    expect(onAmend).toHaveBeenCalledWith({ message: undefined, keepMessage: true, resetDate: false, resetAuthor: false, only: false, pushAfter: false });
  });

  it('amends with the edited message when keep is unchecked', async () => {
    const onAmend = vi.fn();
    const { container, getByText } = render(AmendModal, { ...base, onClose: () => {}, onAmend });
    const keep = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(keep);
    const textarea = container.querySelector<HTMLTextAreaElement>('#amend-message')!;
    await fireEvent.input(textarea, { target: { value: 'new message' } });
    await fireEvent.click(getByText('Amend'));
    expect(onAmend).toHaveBeenCalledWith({ message: 'new message', keepMessage: false, resetDate: false, resetAuthor: false, only: false, pushAfter: false });
  });

  it('disables Amend when editing with an empty message', async () => {
    const { container, getByText } = render(AmendModal, { ...base, message: '', onClose: () => {}, onAmend: () => {} });
    const keep = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(keep); // edit mode, message empty
    expect((getByText('Amend') as HTMLButtonElement).disabled).toBe(true);
  });

  it('passes only:true when the --only checkbox is checked', async () => {
    const onAmend = vi.fn();
    const { container, getByText } = render(AmendModal, { ...base, onClose: () => {}, onAmend });
    // Checkboxes order: keepMessage, resetDate, resetAuthor, only
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await fireEvent.click(checkboxes[3]); // --only
    await fireEvent.click(getByText('Amend'));
    expect(onAmend).toHaveBeenCalledWith(expect.objectContaining({ only: true, keepMessage: true }));
  });

  it('forwards pushAfter when the push-after checkbox is checked', async () => {
    const onAmend = vi.fn();
    const { container, getByText } = render(AmendModal, { ...base, onClose: () => {}, onAmend });
    // Checkboxes order: keepMessage, resetDate, resetAuthor, only, pushAfter
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await fireEvent.click(checkboxes[4]); // pushAfter
    await fireEvent.click(getByText('Amend'));
    expect(onAmend).toHaveBeenCalledWith(expect.objectContaining({ pushAfter: true }));
  });

  it('initializes options from defaultsStore', async () => {
    defaultsStore.current.amend = { keepMessage: false, resetDate: true, resetAuthor: false, only: false, pushAfter: true };
    const { container } = render(AmendModal, { ...base, onClose: () => {}, onAmend: () => {} });
    const textarea = container.querySelector<HTMLTextAreaElement>('#amend-message')!;
    // keepMessage: false → textarea should be editable (not readonly)
    expect(textarea.readOnly).toBe(false);
    // pushAfter: true → 5th checkbox (index 4) should be checked
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes[4]!.checked).toBe(true);
  });

  it('shows the pushed warning only when isPushed', () => {
    const { queryByRole, rerender } = render(AmendModal, { ...base, isPushed: false, onClose: () => {}, onAmend: () => {} });
    expect(queryByRole('alert')).toBeNull();
    rerender({ ...base, isPushed: true, onClose: () => {}, onAmend: () => {} });
    expect(queryByRole('alert')).not.toBeNull();
  });
});
