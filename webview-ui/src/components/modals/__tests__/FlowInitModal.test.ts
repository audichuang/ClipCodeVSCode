import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import FlowInitModal from '../FlowInitModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

const baseProps = { onClose: vi.fn(), onInit: vi.fn() };

describe('FlowInitModal', () => {
  it('default submit ships the standard git-flow defaults', async () => {
    const onInit = vi.fn();
    const { container } = render(FlowInitModal, { ...baseProps, onInit });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onInit).toHaveBeenCalledWith({
      productionBranch: 'main',
      developBranch: 'develop',
      featurePrefix: 'feature/',
      releasePrefix: 'release/',
      hotfixPrefix: 'hotfix/',
      versionTagPrefix: '',
    });
  });

  it('edited values propagate into the payload', async () => {
    const onInit = vi.fn();
    const { container } = render(FlowInitModal, { ...baseProps, onInit });
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[0], { target: { value: 'master' } }); // production
    await fireEvent.input(inputs[1], { target: { value: 'dev' } });    // develop
    await fireEvent.input(inputs[5], { target: { value: 'v' } });      // version tag prefix
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    const arg = onInit.mock.calls[0][0];
    expect(arg.productionBranch).toBe('master');
    expect(arg.developBranch).toBe('dev');
    expect(arg.versionTagPrefix).toBe('v');
  });

  it('primary disabled when production or develop is blank', async () => {
    const { container } = render(FlowInitModal, baseProps);
    const inputs = container.querySelectorAll<HTMLInputElement>('input.modal-input');
    await fireEvent.input(inputs[0], { target: { value: '   ' } });
    const primary = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(primary.disabled).toBe(true);
  });

  it('cancel fires onClose, not onInit', async () => {
    const onClose = vi.fn();
    const onInit = vi.fn();
    const { container } = render(FlowInitModal, { ...baseProps, onClose, onInit });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.form-actions button')!);
    expect(onClose).toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
  });
});
