import { describe, it, expect } from 'vitest';
import { DEFAULT_GRAPH_COLORS, resolveGraphColors } from '../graph-colors';

describe('resolveGraphColors', () => {
  it('returns valid hex colors in order', () => {
    const input = ['#fff', '#123456', '#ABCDEF'];
    expect(resolveGraphColors(input)).toEqual(['#fff', '#123456', '#ABCDEF']);
  });

  it('drops invalid entries (bad hex, non-strings, wrong length)', () => {
    const input = ['#63b0f4', 'red', '#12', '#1234', 123, null, '#73d13d'];
    expect(resolveGraphColors(input)).toEqual(['#63b0f4', '#73d13d']);
  });

  it('falls back to the default palette when input is empty', () => {
    expect(resolveGraphColors([])).toEqual(DEFAULT_GRAPH_COLORS);
  });

  it('falls back to the default palette when every entry is invalid', () => {
    expect(resolveGraphColors(['nope', '#xyz', 42])).toEqual(DEFAULT_GRAPH_COLORS);
  });

  it('falls back to the default palette for non-array input', () => {
    expect(resolveGraphColors(undefined)).toEqual(DEFAULT_GRAPH_COLORS);
    expect(resolveGraphColors('#fff')).toEqual(DEFAULT_GRAPH_COLORS);
    expect(resolveGraphColors(null)).toEqual(DEFAULT_GRAPH_COLORS);
  });

  it('default palette is the current 12-color set', () => {
    expect(DEFAULT_GRAPH_COLORS).toHaveLength(12);
    expect(DEFAULT_GRAPH_COLORS[0]).toBe('#63b0f4');
  });
});
