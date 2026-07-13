import { describe, it, expect } from 'vitest';
import { computeWordDiff, pairHunkWordDiffs, type DiffLineLite } from '../word-diff';

describe('computeWordDiff', () => {
  it('highlights only the changed trailing word (Audi Mac → Audi asdsadadMac)', () => {
    const { delRanges, addRanges } = computeWordDiff('Audi Mac', 'Audi asdsadadMac');
    // "Audi " (0..5) is common; the last token differs.
    expect(delRanges).toEqual([{ start: 5, end: 8 }]);        // "Mac"
    expect(addRanges).toEqual([{ start: 5, end: 16 }]);       // "asdsadadMac"
  });

  it('returns no ranges for identical lines', () => {
    expect(computeWordDiff('same', 'same')).toEqual({ delRanges: [], addRanges: [] });
  });

  it('marks the whole added line changed when the old line is empty', () => {
    expect(computeWordDiff('', 'hello')).toEqual({ delRanges: [], addRanges: [{ start: 0, end: 5 }] });
  });

  it('merges adjacent changed tokens into one range', () => {
    // "a b c" → "a X Y" : tokens b and c both change but are separated by a
    // space that stays; each changed word is its own range (space unchanged).
    const { addRanges } = computeWordDiff('a b c', 'a X Y');
    expect(addRanges).toEqual([{ start: 2, end: 3 }, { start: 4, end: 5 }]);
  });

  it('treats a replaced emoji as one changed token, not a split surrogate half', () => {
    // 😀 (U+1F600) and 😅 (U+1F605) are each a UTF-16 surrogate pair. Without
    // Unicode-aware tokenizing, the LCS could match the shared high surrogate
    // and only flag the low surrogate half as changed — a range boundary
    // landing mid-pair. Both ranges here must bracket the FULL emoji (2 UTF-16
    // units), matching Shiki's UTF-16 offsets exactly.
    const { delRanges, addRanges } = computeWordDiff('go 😀 now', 'go 😅 now');
    expect(delRanges).toEqual([{ start: 3, end: 5 }]); // "😀"
    expect(addRanges).toEqual([{ start: 3, end: 5 }]); // "😅"
  });

  it('falls back to whole-line ranges for very long lines', () => {
    const long = 'x'.repeat(500);
    const { delRanges, addRanges } = computeWordDiff(long, long + 'y');
    expect(delRanges).toEqual([{ start: 0, end: 500 }]);
    expect(addRanges).toEqual([{ start: 0, end: 501 }]);
  });

  /* SNIPCODE-HOOK start: Batch C word-diff token-matrix cap regression. */
  it('falls back to whole-line ranges when the token matrix exceeds the cap', () => {
    const oldLine = `!${'.'.repeat(199)}?`;
    const newLine = `!${'#'.repeat(199)}?`;

    expect(computeWordDiff(oldLine, newLine)).toEqual({
      delRanges: [{ start: 0, end: 201 }],
      addRanges: [{ start: 0, end: 201 }],
    });
  });
  /* SNIPCODE-HOOK end */
});

describe('pairHunkWordDiffs', () => {
  it('pairs the k-th delete with the k-th add in a replace block', () => {
    const lines: DiffLineLite[] = [
      { type: 'context', content: 'ctx' },
      { type: 'delete', content: 'Audi Mac' },
      { type: 'delete', content: 'foo bar' },
      { type: 'add', content: 'Audi asdsadadMac' },
      { type: 'add', content: 'foo baz' },
      { type: 'context', content: 'end' },
    ];
    const map = pairHunkWordDiffs(lines);
    // del idx 1 ↔ add idx 3
    expect(map.get(1)).toEqual({ ranges: [{ start: 5, end: 8 }], kind: 'delete' });
    expect(map.get(3)).toEqual({ ranges: [{ start: 5, end: 16 }], kind: 'add' });
    // del idx 2 ↔ add idx 4 ("bar" → "baz")
    expect(map.get(2)?.kind).toBe('delete');
    expect(map.get(4)?.kind).toBe('add');
  });

  it('does not pair a pure addition block (no matching deletes)', () => {
    const lines: DiffLineLite[] = [
      { type: 'context', content: 'a' },
      { type: 'add', content: 'brand new' },
    ];
    expect(pairHunkWordDiffs(lines).size).toBe(0);
  });

  it('pairs only min(dels, adds) lines when the block is uneven', () => {
    const lines: DiffLineLite[] = [
      { type: 'delete', content: 'one' },
      { type: 'add', content: 'ONE' },
      { type: 'add', content: 'extra' }, // no delete to pair with
    ];
    const map = pairHunkWordDiffs(lines);
    expect(map.has(0)).toBe(true);   // del one ↔ add ONE
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);  // extra add unpaired
  });

  /* SNIPCODE-HOOK start: Batch C word-diff performance regression. */
  it('falls back to line-level highlighting for a 1500-line rewrite block', () => {
    const lines: DiffLineLite[] = [];
    for (let i = 0; i < 1500; i++) lines.push({ type: 'delete', content: `old value ${i}` });
    for (let i = 0; i < 1500; i++) lines.push({ type: 'add', content: `new value ${i}` });

    expect(pairHunkWordDiffs(lines).size).toBe(0);
  });
  /* SNIPCODE-HOOK end */
});
