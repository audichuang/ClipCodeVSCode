import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TagDetailsModal from '../TagDetailsModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

describe('TagDetailsModal', () => {
  it('renders the tag name pill', () => {
    const { container } = render(TagDetailsModal, { name: 'v2.0', onClose: vi.fn() });
    expect(container.querySelector('.modal-pill--tag')?.textContent).toContain('v2.0');
  });

  it('shows the message textarea when message prop is set', () => {
    const { container } = render(TagDetailsModal, {
      name: 'v2.0',
      message: 'Release notes here',
      onClose: vi.fn(),
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.tag-details-message');
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('Release notes here');
  });

  it('omits the message textarea when message is undefined', () => {
    const { container } = render(TagDetailsModal, { name: 'v2.0', onClose: vi.fn() });
    expect(container.querySelector('.tag-details-message')).toBeNull();
  });

  it('close button fires onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(TagDetailsModal, { name: 'v', onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button')!);
    expect(onClose).toHaveBeenCalled();
  });
});
