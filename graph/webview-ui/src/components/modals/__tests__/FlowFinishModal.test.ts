import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import FlowFinishModal from '../FlowFinishModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { FlowConfig } from '../../../lib/types';

const config: FlowConfig = {
  productionBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  versionTagPrefix: 'v',
};

const baseProps = {
  flowType: 'feature',
  branchName: 'feature/login',
  config,
  onClose: vi.fn(),
  onFinish: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });

describe('FlowFinishModal', () => {
  it('feature flow renders 3 steps', () => {
    const { container } = render(FlowFinishModal, baseProps);
    expect(container.querySelectorAll('.flow-step').length).toBe(3);
  });

  it('release flow renders 4 steps including a tag step', () => {
    const { container } = render(FlowFinishModal, {
      ...baseProps,
      flowType: 'release',
      branchName: 'release/1.0',
    });
    const steps = container.querySelectorAll('.flow-step');
    expect(steps.length).toBe(4);
    // step 2 is the tag step — icon is codicon-tag
    expect(steps[1].querySelector('.codicon-tag')).not.toBeNull();
  });

  it('hotfix flow renders 4 steps including a tag step', () => {
    const { container } = render(FlowFinishModal, {
      ...baseProps,
      flowType: 'hotfix',
      branchName: 'hotfix/2.1',
    });
    expect(container.querySelectorAll('.flow-step').length).toBe(4);
  });

  it('renders the branch pill', () => {
    const { container } = render(FlowFinishModal, baseProps);
    expect(container.querySelector('.modal-pill--danger')?.textContent).toContain('feature/login');
  });

  it('primary button fires onFinish', async () => {
    const onFinish = vi.fn();
    const { container } = render(FlowFinishModal, { ...baseProps, onFinish });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onFinish).toHaveBeenCalled();
  });

  it('cancel fires onClose, not onFinish', async () => {
    const onClose = vi.fn();
    const onFinish = vi.fn();
    const { container } = render(FlowFinishModal, { ...baseProps, onClose, onFinish });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.form-actions button')!);
    expect(onClose).toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });
});
