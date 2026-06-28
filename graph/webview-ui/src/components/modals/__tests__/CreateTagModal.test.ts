import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import CreateTagModal from '../CreateTagModal.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { defaultsStore } from '../../../lib/stores/defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../../lib/defaults-shape';
import type { TagInfo } from '../../../lib/types';

function setTags(tags: TagInfo[] = []) {
  branchStore.setData({ branches: [], tags, remotes: [], stashes: [], worktrees: [] });
}

beforeEach(() => {
  i18n.setLocale('en');
  setTags();
});
afterEach(() => { defaultsStore.current = structuredClone(DEFAULT_MODAL_DEFAULTS); });

describe('CreateTagModal — defaults store', () => {
  it('initializes push from defaultsStore.current.createTag.push', () => {
    defaultsStore.current.createTag = { push: false };
    const { container } = render(CreateTagModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const pushCheckbox = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]')!;
    expect(pushCheckbox.checked).toBe(false);
  });
});

describe('CreateTagModal', () => {
  it('disables submit until a name is entered', () => {
    const { container } = render(CreateTagModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit!.disabled).toBe(true);
  });

  it('disables submit when tag name collides with an existing tag', async () => {
    setTags([{ name: 'v1.0', hash: 'abc', isAnnotated: false }]);
    const { container } = render(CreateTagModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-tag-name');
    await fireEvent.input(nameInput!, { target: { value: 'v1.0' } });

    expect(container.querySelector('.modal-warning')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('passes name, message, start point, and push flag to onCreate', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateTagModal, {
      startPoint: 'abc1234',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-tag-name');
    const messageInput = container.querySelector<HTMLTextAreaElement>('#create-tag-message');
    await fireEvent.input(nameInput!, { target: { value: 'v2.0' } });
    await fireEvent.input(messageInput!, { target: { value: 'release notes' } });

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledWith('v2.0', 'release notes', 'abc1234', true);
  });

  it('omits push when the checkbox is unticked', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateTagModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-tag-name');
    await fireEvent.input(nameInput!, { target: { value: 'v1.1' } });

    const checkbox = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]');
    await fireEvent.click(checkbox!);

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledWith('v1.1', '', 'main', false);
  });

  it('rejects ref names with invalid characters via the validator', async () => {
    const { container } = render(CreateTagModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-tag-name');
    await fireEvent.input(nameInput!, { target: { value: 'bad:name' } });

    expect(container.querySelector('.modal-warning')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });
});
