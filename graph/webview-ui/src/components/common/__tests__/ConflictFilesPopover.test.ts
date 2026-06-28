import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import ConflictFilesPopover from '../ConflictFilesPopover.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

// Trigger content shared across tests.
const trigger = createRawSnippet(() => ({
  render: () => `<span class="trigger-label">Merge conflict in 2 file(s)</span>`,
}));

function renderPopover(props: { files: string[]; truncated?: boolean }) {
  return render(ConflictFilesPopover, { props: { ...props, children: trigger } });
}

describe('ConflictFilesPopover', () => {
  it('renders the trigger content', () => {
    const { container } = renderPopover({ files: ['src/a.ts', 'src/b.ts'] });
    expect(container.querySelector('.trigger-label')?.textContent).toBe('Merge conflict in 2 file(s)');
  });

  it('does not show the popover until hovered', () => {
    const { container } = renderPopover({ files: ['src/a.ts'] });
    expect(container.querySelector('.conflict-files-popover')).toBeNull();
  });

  it('lists every conflicting file on hover', async () => {
    const { container } = renderPopover({ files: ['src/a.ts', 'src/nested/b.ts'] });
    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);

    const items = container.querySelectorAll('.conflict-files-popover__item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('src/a.ts');
    expect(items[1].textContent).toContain('src/nested/b.ts');
  });

  it('shows the title in the header without duplicating the count', async () => {
    const { container } = renderPopover({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);

    const header = container.querySelector('.conflict-files-popover__header')!;
    expect(header.textContent).toContain('Conflicting files');
    // The count already lives in the trigger label, so it must not be repeated here.
    expect(header.textContent).not.toContain('3');
  });

  it('shows a truncation note when truncated', async () => {
    const { container } = renderPopover({ files: ['src/a.ts'], truncated: true });
    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);

    const note = container.querySelector('.conflict-files-popover__truncated');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('checked first 20 commits only');
  });

  it('omits the truncation note when not truncated', async () => {
    const { container } = renderPopover({ files: ['src/a.ts'], truncated: false });
    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
    expect(container.querySelector('.conflict-files-popover__truncated')).toBeNull();
  });

  it('never shows a popover when there are no files', async () => {
    const { container } = renderPopover({ files: [] });
    await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
    expect(container.querySelector('.conflict-files-popover')).toBeNull();
  });

  it('hides the popover after the trigger is left', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderPopover({ files: ['src/a.ts'] });
      await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
      expect(container.querySelector('.conflict-files-popover')).not.toBeNull();

      await fireEvent.mouseLeave(container.querySelector('.conflict-files-trigger')!);
      await vi.advanceTimersByTimeAsync(300);
      expect(container.querySelector('.conflict-files-popover')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the shared tooltip action on file items instead of a native title', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderPopover({ files: ['src/very/long/path/to/a.ts'] });
      await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
      const item = container.querySelector('.conflict-files-popover__item')!;
      // No native title attribute — the shared tooltip system handles it.
      expect(item.getAttribute('title')).toBeNull();
      await fireEvent.mouseEnter(item);
      vi.advanceTimersByTime(500);
      expect(document.body.querySelector('.vsg-tooltip')?.textContent).toBe('src/very/long/path/to/a.ts');
    } finally {
      vi.useRealTimers();
      document.body.innerHTML = '';
    }
  });

  it('keeps the popover open while it is hovered', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderPopover({ files: ['src/a.ts'] });
      await fireEvent.mouseEnter(container.querySelector('.conflict-files-trigger')!);
      await fireEvent.mouseLeave(container.querySelector('.conflict-files-trigger')!);
      // Mouse moved onto the popover before the close timer fired.
      await fireEvent.mouseEnter(container.querySelector('.conflict-files-popover')!);
      await vi.advanceTimersByTimeAsync(300);
      expect(container.querySelector('.conflict-files-popover')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
