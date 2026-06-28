import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import BisectBanner from '../BisectBanner.svelte';

// BisectBanner parses raw git bisect stdout via regex. Wrong parsing would
// show the wrong commit hash to the user as the "culprit" — high-stakes
// regression target.

describe('BisectBanner — in-progress message parsing', () => {
  const inProgress =
    'Bisecting: 3 revisions left to test after this (roughly 2 steps)\n' +
    '[abcdef1234567890] Some commit subject';

  it('renders the current hash (short form) from [hash]', () => {
    const { container } = render(BisectBanner, { message: inProgress, onReset: vi.fn() });
    const hashEl = container.querySelector('.bisect-hash');
    expect(hashEl?.textContent).toBe('abcdef1');
  });

  it('shows Good/Bad/Skip/Reset action buttons while bisecting', () => {
    const { container } = render(BisectBanner, { message: inProgress, onReset: vi.fn() });
    const buttons = container.querySelectorAll('button');
    // Good + Bad + Skip + Reset = 4
    expect(buttons.length).toBe(4);
  });

  it('does NOT mark the banner as finished when message has no culprit phrase', () => {
    const { container } = render(BisectBanner, { message: inProgress, onReset: vi.fn() });
    expect(container.querySelector('.bisect-banner.finished')).toBeNull();
  });

  it('falls back to no remaining-steps display when "roughly N step" is missing', () => {
    const { container } = render(BisectBanner, {
      message: '[abcdef1234567890] commit',
      onReset: vi.fn(),
    });
    expect(container.querySelector('.bisect-remaining')).toBeNull();
  });

  it('posts bisectGood when Good button clicked', async () => {
    globalThis.__postedMessages = [];
    const { container } = render(BisectBanner, { message: inProgress, onReset: vi.fn() });
    const goodBtn = container.querySelector<HTMLButtonElement>('button.success');
    await fireEvent.click(goodBtn!);
    expect(globalThis.__postedMessages.map(m => (m.data as { type: string }).type))
      .toContain('bisectGood');
  });

  it('posts bisectBad when Bad button clicked', async () => {
    globalThis.__postedMessages = [];
    const { container } = render(BisectBanner, { message: inProgress, onReset: vi.fn() });
    const badBtn = container.querySelector<HTMLButtonElement>('button.danger');
    await fireEvent.click(badBtn!);
    expect(globalThis.__postedMessages.map(m => (m.data as { type: string }).type))
      .toContain('bisectBad');
  });
});

describe('BisectBanner — finished message parsing', () => {
  // git bisect terminates with a `git log` style block on stdout; reproduce
  // the canonical shape so regex assertions exercise real input.
  const finishedMsg =
    'abc1234567890abcdef1234567890abcdef1234567 is the first bad commit\n' +
    'commit abc1234567890abcdef1234567890abcdef1234567\n' +
    'Author: Jane Dev <jane@example.com>\n' +
    'Date:   2024-01-15\n' +
    '\n' +
    '    Broke the parser by inverting the condition\n' +
    '\n' +
    ':100644 100644 abc def M src/parser.ts';

  it('flags banner as finished when message ends with "is the first bad commit"', () => {
    const { container } = render(BisectBanner, { message: finishedMsg, onReset: vi.fn() });
    expect(container.querySelector('.bisect-banner.finished')).not.toBeNull();
  });

  it('extracts culprit hash (short form) from the first line', () => {
    const { container } = render(BisectBanner, { message: finishedMsg, onReset: vi.fn() });
    const hashEl = container.querySelector('.bisect-culprit .bisect-hash');
    expect(hashEl?.textContent).toBe('abc1234');
  });

  it('extracts culprit commit subject (first non-header indented line)', () => {
    const { container } = render(BisectBanner, { message: finishedMsg, onReset: vi.fn() });
    const summary = container.querySelector('.bisect-summary');
    expect(summary?.textContent).toBe('Broke the parser by inverting the condition');
  });

  it('hides Good/Bad/Skip buttons once finished, keeps only Reset', () => {
    const { container } = render(BisectBanner, { message: finishedMsg, onReset: vi.fn() });
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].className).toContain('bisect-reset');
  });

  it('invokes onReset callback when Reset clicked (no postMessage)', async () => {
    globalThis.__postedMessages = [];
    const onReset = vi.fn();
    const { container } = render(BisectBanner, { message: finishedMsg, onReset });
    const resetBtn = container.querySelector<HTMLButtonElement>('button.bisect-reset');
    await fireEvent.click(resetBtn!);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(globalThis.__postedMessages).toEqual([]);
  });


  it('Skip button posts bisectSkip', async () => {
    globalThis.__postedMessages = [];
    const { container } = render(BisectBanner, {
      message: 'Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[abcdef1234] Some subject',
      onReset: vi.fn(),
    });
    // Skip is the third action button (Good, Bad, Skip, Reset)
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    // Find by text — the order in the DOM may be Good, Bad, Skip, Reset.
    const skipBtn = Array.from(buttons).find(b => /skip/i.test(b.textContent ?? ''))!;
    await fireEvent.click(skipBtn);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'bisectSkip'
    )).toBe(true);
  });
});
