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

  it('wraps only the changed range inside its OWN color span, leaving surrounding colored tokens whole', () => {
    // Stub a loaded grammar that tokenized "Audi Mac" into 3 colored tokens
    // ('Audi', ' ', 'Mac'). The changed range [5,8) = "Mac" exactly covers the
    // last token, so the word-diff span must nest INSIDE that token's own
    // color span, and the untouched 'Audi'/' ' color spans must come through
    // unsplit (guards the colored-token split path, not just the no-grammar
    // fallback the other tests above cover).
    const coloredHl = {
      getLoadedLanguages: () => ['x'],
      codeToTokens: () => ({
        tokens: [[
          { content: 'Audi', color: '#111' },
          { content: ' ', color: '#222' },
          { content: 'Mac', color: '#333' },
        ]],
      }),
    } as unknown as HighlighterCore;

    const html = highlightLineWithRanges(coloredHl, 'Audi Mac', 'x', [{ start: 5, end: 8 }], 'delete');
    expect(html).toBe(
      '<span style="color:#111">Audi</span>' +
      '<span style="color:#222"> </span>' +
      '<span style="color:#333"><span class="word-diff-del">Mac</span></span>',
    );
  });

  it('keeps an emoji surrogate pair intact even when a range boundary lands mid-pair', () => {
    // 'a😀b': a=0, 😀=[1,3) (UTF-16 surrogate pair), b=3. A range of [2,4) would,
    // if split per UTF-16 code unit, tear the emoji into a lone high surrogate
    // (left as plain text) and a lone low surrogate (wrapped) — both invalid on
    // their own once rendered. The pair must land wholly on one side instead.
    const html = highlightLineWithRanges(stubHl, 'a😀b', '', [{ start: 2, end: 4 }], 'add');
    expect(html).toBe('a😀<span class="word-diff-add">b</span>');
    expect(html).not.toContain('\uD83D<'); // no lone high surrogate split into its own span
  });
});
