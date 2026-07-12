import { describe, it, expect } from 'vitest';
import { highlightLineWithRanges } from '../highlighter';
import type { HighlighterCore } from 'shiki';

// A stub highlighter with no loaded languages: highlightLineWithRanges must fall
// back to plain (uncolored) tokens and still wrap the changed range.
const stubHl = { getLoadedLanguages: () => [] as string[] } as unknown as HighlighterCore;

describe('highlightLineWithRanges', () => {
  it('wraps only the changed char range on a plain-text (no-grammar) line', () => {
    // "Audi Mac", range [5,8) = "Mac".
    const html = highlightLineWithRanges(stubHl, 'Audi Mac', '', [{ start: 5, end: 8 }], 'delete');
    expect(html).toBe('Audi <span class="word-diff-del">Mac</span>');
  });

  it('escapes HTML inside and outside the range', () => {
    const html = highlightLineWithRanges(stubHl, 'a<b', '', [{ start: 1, end: 3 }], 'add');
    expect(html).toBe('a<span class="word-diff-add">&lt;b</span>');
  });

  it('returns plain highlighting when there are no ranges', () => {
    const html = highlightLineWithRanges(stubHl, 'abc', '', [], 'add');
    expect(html).toBe('abc'); // escapeHtml fallback, no word-diff span
  });
});
