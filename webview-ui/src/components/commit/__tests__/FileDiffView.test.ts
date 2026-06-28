import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import FileDiffView from '../FileDiffView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { DiffData } from '../../../lib/types';

// One hunk holding two separate change blocks split by a context line. The whole
// hunk is the reverse unit now, so the clicked line only identifies its hunk.
//   0 ctx a
//   1 del b
//   2 add b2
//   3 ctx c
//   4 add d1
//   5 add d2
//   6 ctx e
function sampleDiff(): DiffData {
  return {
    file: 'src/foo.ts',
    isBinary: false,
    isImage: false,
    hunks: [
      {
        header: '@@ -1,4 +1,5 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        lines: [
          { type: 'context', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
          { type: 'delete', content: 'b', oldLineNumber: 2 },
          { type: 'add', content: 'b2', newLineNumber: 2 },
          { type: 'context', content: 'c', oldLineNumber: 3, newLineNumber: 3 },
          { type: 'add', content: 'd1', newLineNumber: 4 },
          { type: 'add', content: 'd2', newLineNumber: 5 },
          { type: 'context', content: 'e', oldLineNumber: 4, newLineNumber: 6 },
        ],
      },
    ],
  };
}

// A diff whose single hunk exceeds MAX_RENDER_LINES (3000), so it renders
// truncated. Reversing must be disabled for the partially-shown hunk to avoid
// silently undoing the unseen tail.
function hugeDiff(): DiffData {
  const lines = [
    { type: 'delete' as const, content: 'old', oldLineNumber: 1 },
    { type: 'add' as const, content: 'new', newLineNumber: 1 },
  ];
  for (let i = 0; i < 3100; i++) {
    lines.push({ type: 'context' as const, content: `ctx${i}`, oldLineNumber: i + 2, newLineNumber: i + 2 } as never);
  }
  return {
    file: 'src/big.ts',
    isBinary: false,
    isImage: false,
    hunks: [{ header: '@@ -1,3101 +1,3101 @@', oldStart: 1, oldLines: 3101, newStart: 1, newLines: 3101, lines }],
  };
}

// Dispatch a real contextmenu MouseEvent we can inspect afterwards (so we can
// assert preventDefault was / wasn't called).
function rightClick(el: Element): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
  el.dispatchEvent(ev);
  return ev;
}

beforeEach(() => i18n.setLocale('en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FileDiffView reverse context menu', () => {
  it('reports the hunk for a changed line', () => {
    const onReverse = vi.fn();
    const onReverseHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse, onReverseHunk });

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines.length).toBe(7);

    // Right-click the added line of the modify pair (index 2) → hunk 0.
    const ev = rightClick(lines[2]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    const arg = onReverse.mock.calls[0][0];
    expect(arg).toMatchObject({ commitHash: 'deadbeef', file: 'src/foo.ts', hunkIndex: 0 });
    expect(arg).not.toHaveProperty('blockLineIndices');
    expect(arg).not.toHaveProperty('isSingleLine');
  });

  it('reports the same hunk regardless of which changed line is clicked', () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[5]); // second add of the second block, still hunk 0
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
  });

  it('offers Reverse Hunk on a context line', () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[0]); // context line → still reverses the whole hunk
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    const arg = onReverse.mock.calls[0][0];
    expect(arg).toMatchObject({ hunkIndex: 0 });
    expect(arg.selectedLineIndices).toBeUndefined();
  });

  it('reverses a wholly-added/deleted file like any other (whole-file hunk/line reverse)', () => {
    // Added/deleted files have no special gating: reversing every line of the
    // hunk undoes the add/delete, and a partial selection reverses just those
    // lines (the backend rewrites the whole-file header). So the affordances
    // behave exactly as for a modified file.
    const onReverse = vi.fn();
    const onReverseHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse, onReverseHunk });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[2]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    // canReverse is true → the per-hunk reverse button renders.
    expect(container.querySelector('.hunk-hunk-btn')).not.toBeNull();
  });

  it('does nothing without a commit hash (compare/uncommitted view)', () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), onReverse });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[2]);
    expect(onReverse).not.toHaveBeenCalled();
  });

  it('forwards the current text selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'picked text' } as unknown as Selection);
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[2]);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ selectionText: 'picked text' });
  });

  it('renders a per-hunk reverse button that reverses the hunk on click', async () => {
    const onReverse = vi.fn();
    const onReverseHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse, onReverseHunk });

    const btn = container.querySelector('.hunk-hunk-btn');
    expect(btn).not.toBeNull();

    await fireEvent.click(btn!);
    expect(onReverseHunk).toHaveBeenCalledTimes(1);
    expect(onReverseHunk.mock.calls[0][0]).toEqual({ commitHash: 'deadbeef', file: 'src/foo.ts', hunkIndex: 0 });
  });

  it('disables reverse on a truncated hunk (avoids reversing unseen lines)', () => {
    const onReverse = vi.fn();
    const onReverseHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: hugeDiff(), commitHash: 'deadbeef', onReverse, onReverseHunk });

    // The hunk is rendered partially, so no reverse button and right-click is a no-op.
    expect(container.querySelector('.hunk-hunk-btn')).toBeNull();
    const firstChanged = container.querySelector('.diff-content .diff-line.diff-delete')!;
    const ev = rightClick(firstChanged);
    expect(onReverse).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('FileDiffView gutter line-selection', () => {
  // The inline gutters, one per rendered line (indices match sampleDiff()).
  function gutters(container: HTMLElement): NodeListOf<Element> {
    return container.querySelectorAll('.diff-content .diff-line .line-gutter');
  }

  it('drag-selects two changed lines and reverses just those', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Drag from the first add (4) to the second add (5).
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[5]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, selectedLineIndices: [4, 5] });
  });

  it('excludes context lines from a range that spans them', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Select indices 2..4 — index 3 is a context line and must be dropped.
    await fireEvent.mouseDown(g[2]);
    await fireEvent.mouseEnter(g[3]);
    await fireEvent.mouseEnter(g[4]);
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[4]);
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toEqual([2, 4]);
  });

  it('shift-click extends the selection', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    await fireEvent.mouseDown(g[1]);
    await fireEvent.mouseUp(window);
    await fireEvent.mouseDown(g[4], { shiftKey: true });
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[4]);
    // 1..4 → changed lines are 1 (del), 2 (add), 4 (add); 3 is context.
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toEqual([1, 2, 4]);
  });

  it('Escape clears the selection (context right-click then reverses the whole hunk)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);
    await fireEvent.keyDown(window, { key: 'Escape' });

    // With the selection cleared, a context-line right-click reverses the whole
    // hunk (no selected lines).
    rightClick(container.querySelectorAll('.diff-content .diff-line')[6]); // context line
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('keeps an active selection when right-clicking the gutter (right-click does not reset it)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Drag-select the two adds (4, 5).
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // A right-click mousedown in the gutter must NOT collapse the selection.
    await fireEvent.mouseDown(g[1], { button: 2 });

    // Right-click a line INSIDE the selection so the selected-lines target is offered.
    rightClick(container.querySelectorAll('.diff-content .diff-line')[4]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, selectedLineIndices: [4, 5] });
  });

  it('does not offer Reverse Selected Lines when right-clicking outside the selected region', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Drag-select the two adds (4, 5).
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Right-click a changed line NOT in the selection → falls back to whole-hunk.
    rightClick(container.querySelectorAll('.diff-content .diff-line')[2]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('left-clicking an already-selected gutter line deselects', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Plain left-click on a line already in the selection clears it.
    await fireEvent.mouseDown(g[4]);

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect([...lines].some(l => l.classList.contains('line-selected'))).toBe(false);

    // A subsequent right-click yields no selected lines.
    rightClick(lines[4]);
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('left-clicking the code region deselects', async () => {
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse: vi.fn() });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    const contents = container.querySelectorAll('.diff-content .diff-line .line-content');
    await fireEvent.mouseDown(contents[4], { button: 0 });

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect([...lines].some(l => l.classList.contains('line-selected'))).toBe(false);
  });

  it('hunk header shows the Hunk N: Lines A-B label', () => {
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse: vi.fn() });
    const range = container.querySelector('.diff-hunk-range')!;
    expect(range.textContent).toContain('Hunk 1');
    expect(range.textContent).toContain('Lines 1-5');
  });

  it('renders a Reverse Lines button that reverses the selection on click', async () => {
    const onReverse = vi.fn();
    const onReverseLines = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse, onReverseLines });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    const btn = container.querySelector('.hunk-lines-btn');
    expect(btn).not.toBeNull();
    await fireEvent.click(btn!);
    expect(onReverseLines).toHaveBeenCalledTimes(1);
    expect(onReverseLines.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, lineIndices: [4, 5] });
  });

  it('applies the line-selected class to selected lines', async () => {
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse: vi.fn() });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines[4].classList.contains('line-selected')).toBe(true);
    expect(lines[5].classList.contains('line-selected')).toBe(true);
    expect(lines[0].classList.contains('line-selected')).toBe(false);
  });

  it('clears the selection when switching to side-by-side (no stale invisible selection)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Toggle to side-by-side (second button in the mode toggle).
    const sbsBtn = container.querySelectorAll('.diff-mode-toggle button')[1];
    await fireEvent.click(sbsBtn);

    // Right-clicking a changed line in SBS reverses the hunk, not a stale selection.
    const addLine = container.querySelector('.sbs-right .diff-line.diff-add')!;
    rightClick(addLine);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('offers Reverse Hunk for a right-click anywhere in an SBS hunk (including empty rows)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });

    const sbsBtn = container.querySelectorAll('.diff-mode-toggle button')[1];
    await fireEvent.click(sbsBtn);

    // Right-click an empty placeholder row inside an SBS hunk → bubbles to the
    // wrapper and offers Reverse Hunk.
    const emptyRow = container.querySelector('.diff-sbs .diff-empty-line')!;
    const ev = rightClick(emptyRow);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    expect(onReverse.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });
});

// A blank line whose content is the empty string — exercises the edge where
// selectedLinesText() returns '' for a single selected blank line.
function blankLineDiff(): DiffData {
  return {
    file: 'src/blank.ts',
    isBinary: false,
    isImage: false,
    hunks: [
      {
        header: '@@ -1,1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [
          { type: 'add', content: '', newLineNumber: 1 }, // blank added line
          { type: 'context', content: 'x', oldLineNumber: 1, newLineNumber: 2 },
        ],
      },
    ],
  };
}

// Two complete hunks, so a selection in one hunk can be tested against a
// right-click in the other.
function twoHunkDiff(): DiffData {
  return {
    file: 'src/two.ts',
    isBinary: false,
    isImage: false,
    hunks: [
      {
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: 'delete', content: 'a', oldLineNumber: 1 },
          { type: 'add', content: 'a2', newLineNumber: 1 },
        ],
      },
      {
        header: '@@ -10,1 +10,1 @@',
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: [
          { type: 'delete', content: 'b', oldLineNumber: 10 },
          { type: 'add', content: 'b2', newLineNumber: 10 },
        ],
      },
    ],
  };
}

describe('FileDiffView copy lines (gutter)', () => {
  function gutters(container: HTMLElement): NodeListOf<Element> {
    return container.querySelectorAll('.diff-content .diff-line .line-gutter');
  }

  it('sets copyLinesText to the joined content of the selection on a gutter right-click', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Select the two adds (4 = 'd1', 5 = 'd2').
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Right-click in the GUTTER of a selected line.
    rightClick(g[4]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0].copyLinesText).toBe('d1\nd2');
  });

  it('includes context lines in copyLinesText (copies everything selected)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Select 2..4: 'b2' (add), 'c' (context), 'd1' (add) — context is kept here.
    await fireEvent.mouseDown(g[2]);
    await fireEvent.mouseEnter(g[3]);
    await fireEvent.mouseEnter(g[4]);
    await fireEvent.mouseUp(window);

    rightClick(g[3]);
    expect(onReverse.mock.calls[0][0].copyLinesText).toBe('b2\nc\nd1');
  });

  it('does NOT offer copy lines when right-clicking the code region', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Right-click in the CODE region (not the gutter) → no copy-lines text.
    const contents = container.querySelectorAll('.diff-content .diff-line .line-content');
    rightClick(contents[4]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0].copyLinesText).toBeUndefined();
  });

  it('does NOT offer copy lines on a gutter right-click when nothing is selected', () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    rightClick(g[2]);
    expect(onReverse.mock.calls[0][0].copyLinesText).toBeUndefined();
  });

  it('still offers copy lines for a single blank selected line (empty string, not undefined)', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: blankLineDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);

    // Select only the blank added line (index 0).
    await fireEvent.mouseDown(g[0]);
    await fireEvent.mouseUp(window);

    rightClick(g[0]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    // Empty string must be passed (defined) so the parent's `!== undefined` gate
    // still shows the menu item for a lone blank line.
    expect(onReverse.mock.calls[0][0].copyLinesText).toBe('');
  });

  it('does NOT offer copy lines when right-clicking a different hunk than the selection', async () => {
    const onReverse = vi.fn();
    const { container } = render(FileDiffView, { diff: twoHunkDiff(), commitHash: 'deadbeef', onReverse });
    const g = gutters(container);
    expect(g.length).toBe(4); // hunk0: 0,1  hunk1: 2,3

    // Select a line in hunk 0.
    await fireEvent.mouseDown(g[1]);
    await fireEvent.mouseUp(window);

    // Right-click the gutter of a line in hunk 1 → copy-lines gated out.
    rightClick(g[2]);
    expect(onReverse).toHaveBeenCalledTimes(1);
    expect(onReverse.mock.calls[0][0]).toMatchObject({ hunkIndex: 1 });
    expect(onReverse.mock.calls[0][0].copyLinesText).toBeUndefined();
  });
});
