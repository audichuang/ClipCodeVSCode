import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import SquashModal from '../SquashModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { Commit } from '../../../lib/types';

beforeEach(() => { i18n.setLocale('en'); });

function mkCommit(hash: string, parents: string[], subject: string, body = ''): Commit {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    author: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    committer: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    subject,
    body,
    parents,
    refs: [],
  };
}

// chain oldest→newest: a → b, base = a^ = "r"
const chain = [mkCommit('a', ['r'], 'first'), mkCommit('b', ['a'], 'second')];

function deliverRebaseCommits(base = 'r') {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'rebaseCommitsData', payload: { base, commits: chain } },
  }));
}

describe('SquashModal', () => {
  it('pre-fills the message with the combined commit messages oldest→newest', () => {
    const { container } = render(SquashModal, {
      chain, base: 'r', hasPushedCommits: false, onClose: vi.fn(),
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value).toBe('first\n\nsecond');
  });

  it('requests the base..HEAD range on mount', () => {
    render(SquashModal, { chain, base: 'r', hasPushedCommits: false, onClose: vi.fn() });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const req = posted.find(p => p.type === 'getRebaseCommits');
    expect(req?.payload?.base).toBe('r');
  });

  it('shows the force-push warning only when commits are already pushed', async () => {
    const { container, rerender } = render(SquashModal, {
      chain, base: 'r', hasPushedCommits: false, onClose: vi.fn(),
    });
    expect(container.querySelector('.modal-warning')).toBeNull();
    await rerender({ chain, base: 'r', hasPushedCommits: true, onClose: vi.fn() });
    expect(container.querySelector('.modal-warning')).not.toBeNull();
  });

  it('keeps the squash button disabled until the rebase range arrives', async () => {
    const { container } = render(SquashModal, {
      chain, base: 'r', hasPushedCommits: false, onClose: vi.fn(),
    });
    const btn = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(btn.disabled).toBe(true);
    deliverRebaseCommits();
    await tick();
    expect(btn.disabled).toBe(false);
  });

  it('posts interactiveRebase with the oldest as pick (+message) and the rest as fixup', async () => {
    const onClose = vi.fn();
    const { container } = render(SquashModal, {
      chain, base: 'r', hasPushedCommits: false, onClose,
    });
    deliverRebaseCommits();
    await tick();

    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);

    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: any }>;
    const rebase = posted.find(p => p.type === 'interactiveRebase');
    expect(rebase).toBeDefined();
    expect(rebase!.payload.base).toBe('r');
    expect(rebase!.payload.todos).toEqual([
      { action: 'pick', hash: 'a', subject: 'first', message: 'first\n\nsecond' },
      { action: 'fixup', hash: 'b', subject: 'second' },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('tags the interactiveRebase with squashCount so the host can notify', async () => {
    const { container } = render(SquashModal, {
      chain, base: 'r', hasPushedCommits: false, onClose: vi.fn(),
    });
    deliverRebaseCommits();
    await tick();

    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);

    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: any }>;
    const rebase = posted.find(p => p.type === 'interactiveRebase');
    expect(rebase!.payload.squashCount).toBe(chain.length);
  });
});
