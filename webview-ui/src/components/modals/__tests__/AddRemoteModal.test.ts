import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import AddRemoteModal from '../AddRemoteModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

const baseProps = { onClose: vi.fn(), onAdd: vi.fn() };

describe('AddRemoteModal', () => {
  it('primary button is disabled until both name and url are filled', async () => {
    const { container } = render(AddRemoteModal, baseProps);
    const primary = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(primary.disabled).toBe(true);
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[0], { target: { value: 'upstream' } });
    expect(primary.disabled).toBe(true);
    await fireEvent.input(inputs[1], { target: { value: 'https://x/y.git' } });
    expect(primary.disabled).toBe(false);
  });

  it('submitting passes trimmed name and url', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddRemoteModal, { ...baseProps, onAdd });
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[0], { target: { value: '  fork  ' } });
    await fireEvent.input(inputs[1], { target: { value: '  https://x  ' } });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onAdd).toHaveBeenCalledWith('fork', 'https://x');
  });

  it('Enter in the url field submits', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddRemoteModal, { ...baseProps, onAdd });
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[0], { target: { value: 'fork' } });
    await fireEvent.input(inputs[1], { target: { value: 'https://x' } });
    await fireEvent.keyDown(inputs[1], { key: 'Enter' });
    expect(onAdd).toHaveBeenCalled();
  });

  it('whitespace-only inputs do not submit on Enter', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddRemoteModal, { ...baseProps, onAdd });
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[1], { target: { value: '   ' } });
    await fireEvent.keyDown(inputs[1], { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('cancel fires onClose, not onAdd', async () => {
    const onClose = vi.fn();
    const onAdd = vi.fn();
    const { container } = render(AddRemoteModal, { ...baseProps, onClose, onAdd });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
