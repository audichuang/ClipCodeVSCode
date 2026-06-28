import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import FlowStartModal from '../FlowStartModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  flowType: 'feature',
  prefix: 'feature/',
  baseBranch: 'develop',
  onClose: vi.fn(),
  onStart: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });

describe('FlowStartModal', () => {
  it('primary button is disabled until name is non-empty', async () => {
    const { container } = render(FlowStartModal, baseProps);
    const primary = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(primary.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('.flow-name')!;
    await fireEvent.input(input, { target: { value: 'login' } });
    expect(primary.disabled).toBe(false);
  });

  it('submitting trims the name and passes it', async () => {
    const onStart = vi.fn();
    const { container } = render(FlowStartModal, { ...baseProps, onStart });
    const input = container.querySelector<HTMLInputElement>('.flow-name')!;
    await fireEvent.input(input, { target: { value: '  login  ' } });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onStart).toHaveBeenCalledWith('login');
  });

  it('Enter submits when name is valid', async () => {
    const onStart = vi.fn();
    const { container } = render(FlowStartModal, { ...baseProps, onStart });
    const input = container.querySelector<HTMLInputElement>('.flow-name')!;
    await fireEvent.input(input, { target: { value: 'login' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('login');
  });

  it('renders the prefix in the inline pill before the input', () => {
    const { container } = render(FlowStartModal, { ...baseProps, prefix: 'release/' });
    expect(container.querySelector('.flow-prefix')?.textContent?.trim()).toBe('release/');
  });

  it('shows a placeholder in the target pill until a name is typed', () => {
    const { container } = render(FlowStartModal, baseProps);
    const targetPill = container.querySelector('.modal-pill--target')?.textContent ?? '';
    expect(targetPill).toContain('feature/...');
  });

  it('cancel fires onClose, not onStart', async () => {
    const onClose = vi.fn();
    const onStart = vi.fn();
    const { container } = render(FlowStartModal, { ...baseProps, onClose, onStart });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.form-actions button')!);
    expect(onClose).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});
