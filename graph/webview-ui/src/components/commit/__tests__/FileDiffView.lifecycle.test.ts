/* SNIPCODE-HOOK start: Batch C diff-view lifecycle/performance regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { DiffData } from '../../../lib/types';

const highlighterState = vi.hoisted(() => ({
  calls: 0,
  ensureLanguageCalls: 0,
  delayFromCall: Number.POSITIVE_INFINITY,
  pending: [] as Array<(value: unknown) => void>,
  /* SNIPCODE-HOOK start: perf — progressive reveal: '' = "no grammar" path */
  lang: 'typescript',
  theme: 'dark-plus',
  onHighlight: undefined as undefined | (() => void),
  workerEnabled: false,
  workerPending: [] as Array<{ resolve: (html: string[]) => void; signal: AbortSignal; length: number; lines?: Array<{ content: string }> }>,
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
    ensureLanguage: () => { highlighterState.ensureLanguageCalls++; return Promise.resolve(true); },
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

vi.mock('../../../lib/utils/highlight-worker-client', () => ({
  warmHighlightWorker: () => {},
  highlightWorkerBatch: (lines: unknown[], _lang: string, _theme: string, signal: AbortSignal) => highlighterState.workerEnabled
    ? new Promise<string[]>(resolve => highlighterState.workerPending.push({ resolve, signal, length: lines.length, lines: lines as Array<{ content: string }> }))
    : Promise.resolve(undefined),
}));

import FileDiffView from '../FileDiffView.svelte';

async function changeToLightTheme(): Promise<void> {
  const delivered = new Promise<void>(resolve => {
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
  highlighterState.theme = 'light-plus';
  document.body.classList.add('vscode-light');
  await delivered;
  await tick();
}

const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function nextWorkerBatch() {
  for (let i = 0; i < 50 && highlighterState.workerPending.length === 0; i++) await task();
  expect(highlighterState.workerPending.length).toBeGreaterThan(0);
  return highlighterState.workerPending.shift()!;
}

async function finishWorkerReveal(isComplete: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !isComplete(); i++) {
    if (highlighterState.workerPending.length === 0) {
      await task();
      continue;
    }
    const batch = highlighterState.workerPending.shift()!;
    expect(batch.signal.aborted).toBe(false);
    expect(batch.lines).toBeDefined();
    batch.resolve(batch.lines!.map(line => `<span data-highlighted="true" data-worker-line="true">${line.content}</span>`));
    await task();
  }
  expect(isComplete()).toBe(true);
}

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

function replacementDiff(count: number): DiffData {
  const lines: DiffData['hunks'][number]['lines'] = [
    ...Array.from({ length: count }, (_, i) => ({
      type: 'delete' as const,
      content: `old-${i}`,
      oldLineNumber: i + 1,
    })),
    ...Array.from({ length: count }, (_, i) => ({
      type: 'add' as const,
      content: `new-${i}`,
      newLineNumber: i + 1,
    })),
  ];
  return {
    file: 'src/rewrite.ts',
    isBinary: false,
    isImage: false,
    hunks: [{
      header: `@@ -1,${count} +1,${count} @@`,
      oldStart: 1,
      oldLines: count,
      newStart: 1,
      newLines: count,
      lines,
    }],
  };
}

beforeEach(() => {
  highlighterState.calls = 0;
  highlighterState.ensureLanguageCalls = 0;
  highlighterState.delayFromCall = Number.POSITIVE_INFINITY;
  highlighterState.pending.length = 0;
  highlighterState.lang = 'typescript';
  highlighterState.theme = 'dark-plus';
  highlighterState.onHighlight = undefined;
  highlighterState.workerEnabled = false;
  highlighterState.workerPending.length = 0;
  document.body.classList.remove('vscode-light');
});

afterEach(() => {
  for (const resolve of highlighterState.pending.splice(0)) resolve({});
  for (const pending of highlighterState.workerPending.splice(0)) pending.resolve([]);
  cleanup();
  // Reset the shared DOM/mock inputs after observers have been disconnected;
  // otherwise a queued MutationObserver callback can affect the next test.
  document.body.classList.remove('vscode-light');
  highlighterState.theme = 'dark-plus';
  highlighterState.onHighlight = undefined;
  highlighterState.workerEnabled = false;
});

describe('FileDiffView lifecycle', () => {
  // Keep enough rows to cross many reveal steps. Deterministic assertions measure
  // repeated row work; this timeout only catches a hung lifecycle test.
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
      await waitFor(() => expect(view.container.querySelectorAll('[data-highlighted]')).toHaveLength(mode === 'inline' ? 3000 : 6000), { timeout: 20000 });
      expect(firstRowReads).toBeLessThanOrEqual(10);
    } finally { spy.mockRestore(); }
  }, 30000);

  it('does not rebuild already revealed side-by-side rows on each batch', async () => {
    const diff = manyLineDiff(600);
    let typeReads = 0;
    for (const line of diff.hunks[0].lines) {
      const type = line.type;
      Object.defineProperty(line, 'type', { get: () => { typeReads++; return type; } });
    }

    const view = render(FileDiffView, { diff, diffMode: 'side-by-side' });
    /* SNIPCODE-HOOK start: a reveal waitFor must carry an explicit timeout BELOW
       its enclosing test's timeout — waitFor's own default is 1s, which 1200
       progressively-revealed rows do not reach, so a bare wait here fails
       ("to have a length of 1200 but got 1080") and the test's 15000 ceiling
       never applies. 10000 < 15000 keeps the assertion, not the test, losing
       first. */
    await waitFor(() => expect(view.container.querySelectorAll('[data-highlighted]')).toHaveLength(1200), { timeout: 10000 });
    /* SNIPCODE-HOOK end */

    // Each source line is paired once and rendered once per pane. Re-reading the
    // entire revealed prefix per batch is the previous quadratic behavior.
    expect(typeReads).toBeLessThan(600 * 12);
  }, 15000);

  it('keeps replacement pairs stable when a reveal boundary falls inside the block', async () => {
    const stagedLines = vi.fn();
    const view = render(FileDiffView, {
      diff: replacementDiff(100),
      diffMode: 'side-by-side',
      onStageHunk: () => {},
      onStageLines: stagedLines,
    });
    const leftRows = () => [...view.container.querySelectorAll('.sbs-left .diff-line')];
    const rightRows = () => [...view.container.querySelectorAll('.sbs-right .diff-line')];

    await waitFor(() => expect(leftRows().length).toBeGreaterThan(0));
    const firstLeft = leftRows()[0];
    const firstRight = rightRows()[0];
    expect(firstLeft.textContent).toContain('old-0');
    expect(firstRight.textContent).toContain('new-0');

    await waitFor(() => expect(leftRows().length).toBeGreaterThan(60));
    expect(leftRows()[0]).toBe(firstLeft);
    expect(rightRows()[0]).toBe(firstRight);
    expect(firstRight.textContent).toContain('new-0');

    await waitFor(() => {
      expect(leftRows()).toHaveLength(100);
      expect(rightRows()).toHaveLength(100);
    });

    const stageBlockButton = view.container.querySelector<HTMLButtonElement>('.sbs-block-stage-btn')!;
    stageBlockButton.focus();
    const refreshed = replacementDiff(100);
    refreshed.hunks[0].lines[0] = { ...refreshed.hunks[0].lines[0], content: 'old-0 refreshed' };
    await view.rerender({ diff: refreshed, diffMode: 'side-by-side', onStageHunk: () => {}, onStageLines: stagedLines });
    expect(view.container.querySelector('.sbs-block-stage-btn')).toBe(stageBlockButton);
    expect(document.activeElement).toBe(stageBlockButton);
    expect(leftRows()[0].textContent).toContain('old-0 refreshed');

    stageBlockButton.click();
    expect(stagedLines).toHaveBeenCalledWith({ file: 'src/rewrite.ts', hunkIndex: 0, lineIndices: Array.from({ length: 200 }, (_, i) => i) });
  });

  it('stops the side-by-side worker pass after every paired row is revealed', async () => {
    highlighterState.workerEnabled = true;
    const view = render(FileDiffView, { diff: replacementDiff(100), diffMode: 'side-by-side' });
    const leftRows = () => view.container.querySelectorAll('.sbs-left .diff-line').length;
    const rightRows = () => view.container.querySelectorAll('.sbs-right .diff-line').length;
    const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

    try {
      while (leftRows() < 100) {
        await waitFor(() => expect(highlighterState.workerPending.length).toBeGreaterThan(0));
        const batch = highlighterState.workerPending.shift()!;
        expect(batch.length).toBeGreaterThan(0);
        batch.resolve(batch.lines!.map(line => `<span data-worker-line="true">${line.content}</span>`));
        await task();
      }
      await task();

      expect(rightRows()).toBe(100);
      expect(highlighterState.workerPending).toHaveLength(0);
    } finally {
      // If the loop regresses and queues an empty batch after completion, leave
      // it unresolved until the effect is cancelled so cleanup cannot spin it.
      view.unmount();
      highlighterState.workerEnabled = false;
    }
  }, 15000);

  it('does not reuse old-theme tail entries when a theme pass is interrupted by refresh', async () => {
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    /* SNIPCODE-HOOK start: 600-row reveals spanning batches — explicit timeouts
       under the it()'s 5000ms default, same rule as above. */
    await waitFor(() => expect(view.container.querySelectorAll('[data-theme="dark-plus"]')).toHaveLength(600), { timeout: 4000 });

    highlighterState.workerEnabled = true;
    await changeToLightTheme();
    await waitFor(() => expect(highlighterState.workerPending.length).toBe(1));
    const interrupted = highlighterState.workerPending[0];
    const partial = view.container.querySelectorAll('[data-theme="light-plus"]').length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(600);

    highlighterState.workerEnabled = false;
    const refreshed = manyLineDiff(600);
    refreshed.hunks[0].lines[599].content = 'const refreshedTail = 599;';
    await view.rerender({ diff: refreshed });
    expect(interrupted.signal.aborted).toBe(true);
    interrupted.resolve(Array(interrupted.length).fill('<span data-stale-theme-pass>obsolete</span>'));
    await waitFor(() => expect(view.container.querySelectorAll('[data-theme="light-plus"]')).toHaveLength(600), { timeout: 4000 });
    /* SNIPCODE-HOOK end */
    expect(view.container.querySelector('[data-theme="dark-plus"]')).toBeNull();
    expect(view.container.querySelector('[data-stale-theme-pass]')).toBeNull();
    expect(view.container.textContent).toContain('const refreshedTail = 599;');
  });

  it('drops a late worker batch after navigating to another file', async () => {
    highlighterState.workerEnabled = true;
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    await waitFor(() => expect(highlighterState.workerPending.length).toBe(1));
    const pending = highlighterState.workerPending[0];
    highlighterState.workerEnabled = false;
    await view.rerender({ diff: oneLineDiff('src/new.ts', 'new file') });
    expect(pending.signal.aborted).toBe(true);
    pending.resolve(Array(200).fill('<span data-stale="true">old worker</span>'));
    await waitFor(() => expect(view.container.querySelector('.line-content')?.textContent).toBe('new file'));
    expect(view.container.querySelector('[data-stale]')).toBeNull();
  });

  it('does not paint after the view is unmounted while highlighting is pending', async () => {
    highlighterState.delayFromCall = 1;
    let tokenized = 0;
    highlighterState.onHighlight = () => { tokenized++; };
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    await waitFor(() => expect(highlighterState.pending.length).toBe(1));

    view.unmount();
    highlighterState.pending.shift()!({});
    await Promise.resolve();
    await Promise.resolve();

    expect(highlighterState.ensureLanguageCalls).toBe(0);
    expect(tokenized).toBe(0);
  });

  it('aborts a worker batch when the theme changes and keeps old-theme output out', async () => {
    highlighterState.workerEnabled = true;
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    await waitFor(() => expect(highlighterState.workerPending.length).toBe(1));
    const oldBatch = highlighterState.workerPending[0];

    // Prevent the replacement pass from adding another unresolved worker
    // request while the MutationObserver/Svelte effect transition settles.
    highlighterState.workerEnabled = false;
    await changeToLightTheme();
    expect(oldBatch.signal.aborted).toBe(true);

    oldBatch.resolve(Array(oldBatch.length).fill('<span data-theme="dark-plus">stale</span>'));
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-theme="light-plus"]')).toHaveLength(600);
    });
    expect(view.container.querySelector('[data-theme="dark-plus"]')).toBeNull();
  });

  it('keeps the reveal position when switching inline and side-by-side', async () => {
    highlighterState.workerEnabled = true;
    const view = render(FileDiffView, { diff: manyHunkDiff(500) });
    const firstProgress = view.container.querySelectorAll('.diff-content .diff-line').length;
    expect(firstProgress).toBeGreaterThan(0);
    expect(firstProgress).toBeLessThan(500);
    const oldBatch = await nextWorkerBatch();

    view.container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button')[1].click();
    await tick();
    expect(oldBatch.signal.aborted).toBe(true);
    expect(view.container.querySelectorAll('.sbs-left .diff-line')).toHaveLength(firstProgress);
    expect(view.container.querySelectorAll('.sbs-right .diff-line')).toHaveLength(firstProgress);

    await finishWorkerReveal(() => view.container.querySelectorAll('.sbs-left .diff-line').length === 500
      && view.container.querySelectorAll('.sbs-right .diff-line').length === 500);

    view.container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button')[0].click();
    await tick();
    expect(view.container.querySelectorAll('.diff-content .diff-line')).toHaveLength(500);
    oldBatch.resolve(Array(oldBatch.length).fill('<span data-stale-mode>obsolete</span>'));
    expect(view.container.querySelector('[data-stale-mode]')).toBeNull();
  });

  it('aborts pending inline worker work and reveals stable side-by-side rows after a mode switch', async () => {
    highlighterState.workerEnabled = true;
    const view = render(FileDiffView, { diff: manyLineDiff(600) });
    const staleBatch = await nextWorkerBatch();

    view.container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button')[1].click();
    await tick();

    expect(staleBatch.signal.aborted).toBe(true);
    await finishWorkerReveal(() => view.container.querySelectorAll('.sbs-left .diff-line').length === 600
      && view.container.querySelectorAll('.sbs-right .diff-line').length === 600);
    staleBatch.resolve(Array(staleBatch.length).fill('<span data-stale-mode>obsolete</span>'));
    expect(view.container.querySelector('[data-stale-mode]')).toBeNull();
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
  it.each(['inline', 'side-by-side'] as const)('reveals every row of a file it cannot highlight (%s)', async mode => {
    highlighterState.lang = '';
    const view = render(FileDiffView, { diff: manyHunkDiff(500), diffMode: mode });
    /* SNIPCODE-HOOK start: same rule as the reveal wait above — a wait that spans
       reveal batches needs an explicit timeout BELOW its enclosing test's, because
       waitFor's default is 1s. This was the thinnest margin left in the file:
       measured 867ms for the whole test under full-suite load, nearly all of it
       inside this wait, i.e. ~1.2x. The sibling at :236 was in the same band and
       really did fail ("got 1080"). The it() here carries no timeout, so vitest's
       5000ms default applies and 10000 would outrank it — 4000 keeps the
       assertion losing first. */
    await waitFor(() => {
      if (mode === 'inline') expect(view.container.querySelectorAll('.diff-content .diff-line').length).toBe(500);
      else {
        expect(view.container.querySelectorAll('.sbs-left .diff-line').length).toBe(500);
        expect(view.container.querySelectorAll('.sbs-right .diff-line').length).toBe(500);
      }
    }, { timeout: 4000 });
    /* SNIPCODE-HOOK end */
    expect(view.container.querySelectorAll('[data-highlighted]').length).toBe(0);
  });

  it('completes pipelined progressive reveal when worker highlighting is active', async () => {
    highlighterState.workerEnabled = true;
    highlighterState.lang = 'typescript';
    const view = render(FileDiffView, { diff: manyHunkDiff(500) });
    const rows = () => view.container.querySelectorAll('.diff-line').length;
    const workerLines = () => view.container.querySelectorAll('[data-worker-line="true"]');
    const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

    // First step renders synchronously locally (60 rows in test environment)
    await task();
    const firstStep = rows();
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(500);
    // Locally highlighted first step rows do not have the worker tag
    expect(workerLines()).toHaveLength(0);

    // Assert prefetch: the next batch was already requested from the worker while yielding
    expect(highlighterState.workerPending.length).toBe(1);
    const firstPrefetch = highlighterState.workerPending[0];
    expect(firstPrefetch.lines).toBeDefined();
    expect(firstPrefetch.lines![0].content).toBe(`const value${firstStep} = ${firstStep};`);

    // Consume batches one by one via pipelined worker responses with identifiable content
    while (rows() < 500) {
      await waitFor(() => expect(highlighterState.workerPending.length).toBeGreaterThan(0));
      const p = highlighterState.workerPending.shift()!;
      expect(p.signal.aborted).toBe(false);
      expect(p.lines).toBeDefined();
      p.resolve(p.lines!.map(l => `<span data-highlighted="true" data-worker-line="true" data-line-content="${l.content}">${l.content}</span>`));
      await task();
    }

    expect(rows()).toBe(500);
    // Tail rows must have been produced by the worker
    expect(workerLines()).toHaveLength(500 - firstStep);

    // Verify full tail row content and sequential order integrity
    expect([...workerLines()].map(node => node.textContent)).toEqual(
      Array.from({ length: 500 - firstStep }, (_, i) =>
        `const value${firstStep + i} = ${firstStep + i};`
      )
    );

    highlighterState.workerEnabled = false;
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
