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

  it('falls back to whole-line ranges for very long lines', () => {
    const long = 'x'.repeat(500);
    const { delRanges, addRanges } = computeWordDiff(long, long + 'y');
    expect(delRanges).toEqual([{ start: 0, end: 500 }]);
    expect(addRanges).toEqual([{ start: 0, end: 501 }]);
  });
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
});
