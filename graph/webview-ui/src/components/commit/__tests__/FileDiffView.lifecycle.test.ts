/* SNIPCODE-HOOK start: Batch C diff-view lifecycle/performance regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import type { DiffData } from '../../../lib/types';

const highlighterState = vi.hoisted(() => ({
  calls: 0,
  delayFromCall: Number.POSITIVE_INFINITY,
  pending: [] as Array<(value: unknown) => void>,
  /* SNIPCODE-HOOK start: perf — progressive reveal: '' = "no grammar" path */
  lang: 'typescript',
  theme: 'dark-plus',
  onHighlight: undefined as undefined | (() => void),
  /* SNIPCODE-HOOK end */
}));

vi.mock('../../../lib/utils/highlighter', () => {
  const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const highlight = (_highlighter: unknown, content: string, ...args: unknown[]) => {
    highlighterState.onHighlight?.();
    return `<span data-highlighted="true" data-theme="${args.at(-1)}">${escapeHtml(content)}</span>`;
  };
  return {
    activeShikiTheme: () => highlighterState.theme,
    detectLanguage: () => highlighterState.lang,
    ensureLanguage: () => Promise.resolve(true),
    escapeHtml,
    getHighlighter: () => {
      highlighterState.calls++;
      if (highlighterState.calls < highlighterState.delayFromCall) return Promise.resolve({});
      return new Promise(resolve => highlighterState.pending.push(resolve));
    },
    highlightLineSync: highlight,
    highlightLineWithRanges: highlight,
  };
});

import FileDiffView from '../FileDiffView.svelte';

function oneLineDiff(file: string, content: string): DiffData {
  return {
    file,
    isBinary: false,
    isImage: false,
    hunks: [{
      header: '@@ -1,1 +1,1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{ type: 'context', content, oldLineNumber: 1, newLineNumber: 1 }],
    }],
  };
}

function manyLineDiff(count: number): DiffData {
  return {
    file: 'src/large.ts',
    isBinary: false,
    isImage: false,
    hunks: [{
      header: `@@ -1,${count} +1,${count} @@`,
      oldStart: 1,
      oldLines: count,
      newStart: 1,
      newLines: count,
      lines: Array.from({ length: count }, (_, i) => ({
        type: 'context' as const,
        content: `const value${i} = ${i};`,
        oldLineNumber: i + 1,
        newLineNumber: i + 1,
      })),
    }],
  };
}

/* SNIPCODE-HOOK start: perf — progressive reveal (first screen first). */
// `count` lines spread over hunks of 10, so the reveal crosses hunk boundaries.
function manyHunkDiff(count: number): DiffData {
  const hunks: DiffData['hunks'] = [];
  for (let start = 0; start < count; start += 10) {
    const n = Math.min(10, count - start);
    hunks.push({
      header: `@@ -${start + 1},${n} +${start + 1},${n} @@`,
      oldStart: start + 1,
      oldLines: n,
      newStart: start + 1,
      newLines: n,
      lines: Array.from({ length: n }, (_, i) => ({
        type: 'context' as const,
        content: `const value${start + i} = ${start + i};`,
        oldLineNumber: start + i + 1,
        newLineNumber: start + i + 1,
      })),
    });
  }
  return { file: 'src/large.ts', isBinary: false, isImage: false, hunks };
}
/* SNIPCODE-HOOK end */

beforeEach(() => {
  highlighterState.calls = 0;
  highlighterState.delayFromCall = Number.POSITIVE_INFINITY;
  highlighterState.pending.length = 0;
  highlighterState.lang = 'typescript';
  highlighterState.theme = 'dark-plus';
  highlighterState.onHighlight = undefined;
  document.body.classList.remove('vscode-light');
});

afterEach(() => {
  for (const resolve of highlighterState.pending.splice(0)) resolve({});
  cleanup();
});

describe('FileDiffView lifecycle', () => {
  it.each(['inline', 'side-by-side'] as const)('does not repeatedly read old rows as new batches arrive (%s)', async mode => {
    const key = JSON.stringify(['src/large.ts', 1, 0, 'const value0 = 0;']);
    const original = Map.prototype.get;
    let firstRowReads = 0;
    const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, k: unknown) {
      if (k === key) firstRowReads++;
      return original.call(this, k);
    });
    try {
      const view = render(FileDiffView, { diff: manyLineDiff(3000), diffMode: mode });
      await waitFor(() => expect(view.container.querySelectorAll('[data-highlighted]')).toHaveLength(mode === 'inline' ? 3000 : 6000), { timeout: 15000 });
      expect(firstRowReads).toBeLessThanOrEqual(10);
    } finally { spy.mockRestore(); }
  }, 20000);

  it('does not reuse old-theme tail entries when a theme pass is interrupted by refresh', async () => {
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    await waitFor(() => expect(view.container.querySelectorAll('[data-theme="dark-plus"]')).toHaveLength(600));
    highlighterState.onHighlight = () => {
      highlighterState.onHighlight = undefined;
      queueMicrotask(() => { void view.rerender({ diff: manyLineDiff(600) }); });
    };
    highlighterState.theme = 'light-plus';
    document.body.classList.add('vscode-light');
    await waitFor(() => expect(view.container.querySelectorAll('[data-theme="light-plus"]')).toHaveLength(600));
    expect(view.container.querySelector('[data-theme="dark-plus"]')).toBeNull();
  });

  it('never shows the previous file highlight while a reused view loads the next file', async () => {
    highlighterState.delayFromCall = 2;
    const view = render(FileDiffView, { diff: oneLineDiff('src/old.ts', 'old source') });
    await waitFor(() => {
      expect(view.container.querySelector('.line-content [data-highlighted]')?.textContent)
        .toBe('old source');
    });

    await view.rerender({ diff: oneLineDiff('src/new.ts', 'new source') });

    expect(view.container.querySelector('.line-content')?.textContent).toBe('new source');
  });

  /* SNIPCODE-HOOK start: perf — progressive reveal (first screen first). */
  // Pins the paint pass at its task boundaries. Synchronously after mount only
  // the first step of rows exists (one viewport + slack, plain until the
  // highlighter's microtasks land); every hunk CONTAINER is there from the
  // start, because Diff.svelte counts `.diff-hunk` right after the DOM patch.
  // Within the mount task (microtasks) the first step is coloured — and ONLY
  // the first step exists: the pass yielded before revealing more. The next
  // task reveals the second step, already coloured, and the tail follows.
  // Asserts relationships, not the step constants: firstStep() is
  // viewport-derived (happy-dom reports innerHeight 768 → 60 rows).
  it('reveals a first screen of rows synchronously, then fills the rest in later tasks', async () => {
    const view = render(FileDiffView, { diff: manyHunkDiff(500) });
    const rows = () => view.container.querySelectorAll('.diff-line').length;
    const lit = () => view.container.querySelectorAll('[data-highlighted]').length;
    const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

    const firstStep = rows();
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(500);
    expect(view.container.querySelectorAll('.diff-hunk').length).toBe(50);

    // This timer was queued before the pass's own yield, so it observes the
    // state at the end of the mount task: step 1 coloured, nothing more shown.
    await task();
    expect(lit()).toBe(firstStep);
    expect(rows()).toBe(firstStep);

    await task();
    expect(rows()).toBeGreaterThan(firstStep);
    expect(rows()).toBeLessThan(500);
    expect(lit()).toBe(rows());

    await waitFor(() => {
      expect(rows()).toBe(500);
      expect(lit()).toBe(500);
    });
  });

  // A grammar-less file must still reveal its whole tail — the pass used to
  // return early there, which was harmless when nothing waited on it.
  it('reveals every row of a file it cannot highlight', async () => {
    highlighterState.lang = '';
    const view = render(FileDiffView, { diff: manyHunkDiff(500) });
    await waitFor(() => {
      expect(view.container.querySelectorAll('.diff-line').length).toBe(500);
    });
    expect(view.container.querySelectorAll('[data-highlighted]').length).toBe(0);
  });

  // A same-file re-push (stage/unstage) must not collapse the reveal back to
  // the first step: that would blank the rows below the fold for a frame.
  it('keeps every revealed row across a same-file re-push', async () => {
    const view = render(FileDiffView, { diff: manyHunkDiff(500) });
    await waitFor(() => expect(view.container.querySelectorAll('.diff-line').length).toBe(500));

    const next = manyHunkDiff(500);
    next.hunks[0].lines[0] = { ...next.hunks[0].lines[0], content: 'changed' };
    await view.rerender({ diff: next });

    expect(view.container.querySelectorAll('.diff-line').length).toBe(500);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: D7 incremental highlight cache */
  it('does not blank an unchanged line back to plain text when the diff prop changes (no flash)', async () => {
    // Two-line diff on the SAME file/hunk position; only the second line's
    // content differs between the "before" and "after" (simulating a re-push
    // after staging a hunk elsewhere in the same file — the pathological case
    // D7 fixes). Line A's cache key (file+hunkStart+lineIdx+content) is
    // IDENTICAL across both renders and must stay highlighted throughout.
    function twoLineDiff(contentB: string): DiffData {
      return {
        file: 'src/same.ts',
        isBinary: false,
        isImage: false,
        hunks: [{
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: [
            { type: 'context', content: 'line A', oldLineNumber: 1, newLineNumber: 1 },
            { type: 'context', content: contentB, oldLineNumber: 2, newLineNumber: 2 },
          ],
        }],
      };
    }

    const view = render(FileDiffView, { diff: twoLineDiff('line B') });
    await waitFor(() => {
      const spans = view.container.querySelectorAll('.line-content [data-highlighted]');
      expect(spans.length).toBe(2);
    });

    // Freeze the NEXT highlighter resolution so the re-highlight pass for the
    // changed line ("line B v2") is still in flight when we inspect the DOM.
    highlighterState.delayFromCall = highlighterState.calls + 1;
    await view.rerender({ diff: twoLineDiff('line B v2') });

    const lineContents = view.container.querySelectorAll('.line-content');
    // Line A: same key as before -> must still be the highlighted span, not
    // plain escaped text (that's the flash D7 removes).
    expect(lineContents[0].querySelector('[data-highlighted]')).not.toBeNull();
    expect(lineContents[0].textContent).toBe('line A');
    // Line B: new key (content changed) -> not yet highlighted, plain text.
    expect(lineContents[1].querySelector('[data-highlighted]')).toBeNull();
    expect(lineContents[1].textContent).toBe('line B v2');
  });
  /* SNIPCODE-HOOK end */
});
/* SNIPCODE-HOOK end */
