import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import CommitHoverCard from '../CommitHoverCard.svelte';
import type { Commit } from '../../../lib/types';

const commit: Commit = {
  hash: 'abcdef1234567890',
  abbreviatedHash: 'abcdef1',
  author: { name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z' },
  committer: { name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z' },
  subject: 'fix: thing',
  body: '',
  parents: [],
  refs: [],
};

describe('CommitHoverCard', () => {
  it('renders author name, email and short hash', () => {
    const { container } = render(CommitHoverCard, { commit, x: 100, y: 100, onClose: vi.fn(), onNavigate: vi.fn() });
    expect(container.querySelector('.author-name')?.textContent).toBe('Alice');
    expect(container.querySelector('.author-email')?.textContent).toContain('alice@example.com');
    expect(container.querySelector('.commit-hash')?.textContent).toBe('abcdef1');
  });

  it('renders the commit subject', () => {
    const { container } = render(CommitHoverCard, { commit, x: 0, y: 0, onClose: vi.fn(), onNavigate: vi.fn() });
    expect(container.querySelector('.commit-subject')?.textContent).toBe('fix: thing');
  });

  it('uses inline style with the provided coordinates', () => {
    const { container } = render(CommitHoverCard, { commit, x: 100, y: 100, onClose: vi.fn(), onNavigate: vi.fn() });
    const card = container.querySelector<HTMLDivElement>('.commit-hover-card')!;
    expect(card.style.left).toMatch(/px$/);
    expect(card.style.top).toMatch(/px$/);
  });

  it('mouseleave fires onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(CommitHoverCard, { commit, x: 50, y: 50, onClose, onNavigate: vi.fn() });
    await fireEvent.mouseLeave(container.querySelector<HTMLDivElement>('.commit-hover-card')!);
    expect(onClose).toHaveBeenCalled();
  });
});
