/* SNIPCODE-HOOK start: Batch C diff-view lifecycle/performance regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import type { DiffData } from '../../../lib/types';

const highlighterState = vi.hoisted(() => ({
  calls: 0,
  delayFromCall: Number.POSITIVE_INFINITY,
  pending: [] as Array<(value: unknown) => void>,
}));

vi.mock('../../../lib/utils/highlighter', () => {
  const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const highlight = (_highlighter: unknown, content: string) =>
    `<span data-highlighted="true">${escapeHtml(content)}</span>`;
  return {
    activeShikiTheme: () => 'dark-plus',
    detectLanguage: () => 'typescript',
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

beforeEach(() => {
  highlighterState.calls = 0;
  highlighterState.delayFromCall = Number.POSITIVE_INFINITY;
  highlighterState.pending.length = 0;
});

afterEach(() => {
  for (const resolve of highlighterState.pending.splice(0)) resolve({});
  cleanup();
});

describe('FileDiffView lifecycle', () => {
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

  it('yields to the next task before highlighting a second chunk', async () => {
    const view = render(FileDiffView, { diff: manyLineDiff(251) });

    const highlightedAtNextTask = await new Promise<number>(resolve => {
      setTimeout(() => {
        resolve(view.container.querySelectorAll('[data-highlighted]').length);
      }, 0);
    });

    expect(highlightedAtNextTask).toBe(0);
  });
});
/* SNIPCODE-HOOK end */
