import { describe, it, expect, beforeEach } from 'vitest';
import { graphColorsStore } from '../graph-colors.svelte';
import { DEFAULT_GRAPH_COLORS, resolveGraphColor } from '../../utils/graph-color';

describe('graphColorsStore', () => {
  beforeEach(() => {
    graphColorsStore.set([...DEFAULT_GRAPH_COLORS]);
  });

  it('starts with the default palette', () => {
    expect(graphColorsStore.palette).toEqual(DEFAULT_GRAPH_COLORS);
  });

  it('updates the palette and changes the resolved color', () => {
    const before = resolveGraphColor(graphColorsStore.palette, 0);
    graphColorsStore.set(['#000000', '#ffffff']);
    expect(graphColorsStore.palette).toEqual(['#000000', '#ffffff']);
    expect(resolveGraphColor(graphColorsStore.palette, 0)).toBe('#000000');
    expect(resolveGraphColor(graphColorsStore.palette, 0)).not.toBe(before);
    // index wraps around the new (shorter) palette
    expect(resolveGraphColor(graphColorsStore.palette, 3)).toBe('#ffffff');
  });

  it('falls back to the default palette when set to an empty array', () => {
    graphColorsStore.set([]);
    expect(graphColorsStore.palette).toEqual(DEFAULT_GRAPH_COLORS);
  });

  it('still lets a pattern override win over the palette', () => {
    graphColorsStore.set(['#000000']);
    expect(resolveGraphColor(graphColorsStore.palette, 0, '#abcdef')).toBe('#abcdef');
  });
});
