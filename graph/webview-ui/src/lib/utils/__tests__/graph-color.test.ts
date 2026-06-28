import { describe, it, expect } from 'vitest';
import { resolveGraphColor } from '../graph-color';

const PALETTE = ['#aaa', '#bbb', '#ccc'];

describe('resolveGraphColor', () => {
  it('returns the override when present', () => {
    expect(resolveGraphColor(PALETTE, 1, '#123456')).toBe('#123456');
  });

  it('falls back to the palette by index (wrapping) when no override', () => {
    expect(resolveGraphColor(PALETTE, 1)).toBe('#bbb');
    expect(resolveGraphColor(PALETTE, 4)).toBe('#bbb');
  });

  it('treats empty-string override as no override', () => {
    expect(resolveGraphColor(PALETTE, 0, '')).toBe('#aaa');
  });
});
