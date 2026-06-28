import { describe, it, expect } from 'vitest';
import { computeNavigationTarget, computeScrollTop, computeJumpTarget, isRowOffscreen } from '../graph-navigation';

// Newest-first list. Linear chain a <- b <- c with a merge:
//   a (top/newest)  parents: [b]
//   b               parents: [c, d]   (merge: first parent c, second d)
//   c               parents: [e]
//   d               parents: [e]
//   e (bottom)      parents: []
const commits = [
  { hash: 'a', parents: ['b'] },
  { hash: 'b', parents: ['c', 'd'] },
  { hash: 'c', parents: ['e'] },
  { hash: 'd', parents: ['e'] },
  { hash: 'e', parents: [] },
];

describe('computeNavigationTarget', () => {
  it('moves down one row', () => {
    expect(computeNavigationTarget(commits, 'a', 'down', false)).toBe('b');
  });

  it('moves up one row', () => {
    expect(computeNavigationTarget(commits, 'b', 'up', false)).toBe('a');
  });

  it('no-ops at the bottom edge moving down', () => {
    expect(computeNavigationTarget(commits, 'e', 'down', false)).toBeNull();
  });

  it('no-ops at the top edge moving up', () => {
    expect(computeNavigationTarget(commits, 'a', 'up', false)).toBeNull();
  });

  it('selects the top row when nothing is selected (down)', () => {
    expect(computeNavigationTarget(commits, null, 'down', false)).toBe('a');
  });

  it('selects the top row when nothing is selected (up)', () => {
    expect(computeNavigationTarget(commits, null, 'up', false)).toBe('a');
  });

  it('selects the top row when current hash is not found', () => {
    expect(computeNavigationTarget(commits, 'zzz', 'down', false)).toBe('a');
  });

  it('jumps to the first parent on jump+down', () => {
    expect(computeNavigationTarget(commits, 'a', 'down', true)).toBe('b');
  });

  it('jump+down on a merge commit follows the first parent only', () => {
    expect(computeNavigationTarget(commits, 'b', 'down', true)).toBe('c');
  });

  it('jump+down no-ops when the first parent is not loaded', () => {
    expect(computeNavigationTarget(commits, 'e', 'down', true)).toBeNull();
  });

  it('jumps to the newest child on jump+up', () => {
    expect(computeNavigationTarget(commits, 'b', 'up', true)).toBe('a');
  });

  it('jump+up picks the newest child when there are multiple', () => {
    // both c and d have parent e; c (index 2) is newer than d (index 3)
    expect(computeNavigationTarget(commits, 'e', 'up', true)).toBe('c');
  });

  it('jump+up no-ops when there is no loaded child', () => {
    expect(computeNavigationTarget(commits, 'a', 'up', true)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(computeNavigationTarget([], 'a', 'down', false)).toBeNull();
  });
});

// rowHeight 30, viewportHeight 300 → 10 rows fit. scrollTop 0 shows rows 0..9
// (row 9 occupies y 270..300, exactly the bottom edge).
describe('computeScrollTop', () => {
  describe("align 'edge' (keyboard step navigation)", () => {
    it('returns null when the row is already fully visible', () => {
      expect(computeScrollTop(5, 30, 0, 300, 'edge')).toBeNull();
    });

    it('returns null for the row sitting exactly at the bottom edge', () => {
      expect(computeScrollTop(9, 30, 0, 300, 'edge')).toBeNull();
    });

    it('scrolls down by a single row when stepping past the bottom edge', () => {
      // row 10 is just below the fold; bring it to the bottom edge (minimal move).
      expect(computeScrollTop(10, 30, 0, 300, 'edge')).toBe(30);
    });

    it('scrolls up to the top edge when stepping above the top', () => {
      // viewport showing rows 1..10 (scrollTop 30); selecting row 0 brings it to the top.
      expect(computeScrollTop(0, 30, 30, 300, 'edge')).toBe(0);
    });

    it('scrolls up by a single row (minimal move) past the top edge', () => {
      expect(computeScrollTop(1, 30, 60, 300, 'edge')).toBe(30);
    });
  });

  describe("align 'edge' with a 3-row scroll margin", () => {
    it('leaves the row alone while it stays outside the margin band', () => {
      // rows 0..9 visible; row 6 bottom (210) is exactly the lower margin line.
      expect(computeScrollTop(6, 30, 0, 300, 'edge', 3)).toBeNull();
    });

    it('scrolls down early to keep 3 rows below the selection', () => {
      // row 7 enters the bottom margin band; scroll one row so rows 8,9,10 stay visible.
      expect(computeScrollTop(7, 30, 0, 300, 'edge', 3)).toBe(30);
    });

    it('scrolls up early to keep 3 rows above the selection', () => {
      // viewport at rows 5..14 (scrollTop 150); selecting row 5 keeps rows 2,3,4 above.
      expect(computeScrollTop(5, 30, 150, 300, 'edge', 3)).toBe(60);
    });

    it('returns a value the browser clamps to 0 near the top of the list', () => {
      // row 0 wants 3 rows above it that do not exist; -90 clamps to 0 on assignment.
      expect(computeScrollTop(0, 30, 0, 300, 'edge', 3)).toBe(-90);
    });

    it('ignores the margin in center mode', () => {
      expect(computeScrollTop(20, 30, 0, 300, 'center', 3)).toBe(465);
    });
  });

  describe("align 'center' (search navigation)", () => {
    it('returns null when the row is already visible', () => {
      expect(computeScrollTop(5, 30, 0, 300, 'center')).toBeNull();
    });

    it('centers a row far below the viewport', () => {
      // targetY 600 - 150 + 15 = 465
      expect(computeScrollTop(20, 30, 0, 300, 'center')).toBe(465);
    });

    it('centers a row above the viewport', () => {
      // targetY 0 - 150 + 15 = -135 (browser clamps to 0 on assignment)
      expect(computeScrollTop(0, 30, 300, 300, 'center')).toBe(-135);
    });
  });
});

// Graph for jump-path tests (newest-first):
//   a  parents [b]
//   b  parents [c, d]   (merge: first parent c, second d)
//   c  parents [e]
//   d  parents [e]
//   e  parents []
// e has two children: c (index 2, newest) and d (index 3).
const jg = [
  { hash: 'a', parents: ['b'] },
  { hash: 'b', parents: ['c', 'd'] },
  { hash: 'c', parents: ['e'] },
  { hash: 'd', parents: ['e'] },
  { hash: 'e', parents: [] },
];

describe('computeJumpTarget', () => {
  it('returns the top row with a fresh path when nothing is selected', () => {
    expect(computeJumpTarget(jg, null, 'down', [])).toEqual({ target: 'a', path: ['a'] });
  });

  it('returns null and an empty path for an empty commit list', () => {
    expect(computeJumpTarget([], 'a', 'down', ['a'])).toEqual({ target: null, path: [] });
  });

  it('pushes the first parent when descending from a fresh path', () => {
    // c -> parents[0] = e
    expect(computeJumpTarget(jg, 'c', 'down', [])).toEqual({ target: 'e', path: ['c', 'e'] });
  });

  it('pushes the newest child when ascending from a fresh path', () => {
    // children of e are c (newest) and d; newest is c
    expect(computeJumpTarget(jg, 'e', 'up', [])).toEqual({ target: 'c', path: ['e', 'c'] });
  });

  it('ascends back to the origin child even when it is not the newest', () => {
    // descended d -> e; ascending must return to d, not the newest child c
    expect(computeNavigationTarget(jg, 'e', 'up', true)).toBe('c'); // baseline: stateless picks c
    expect(computeJumpTarget(jg, 'e', 'up', ['d', 'e'])).toEqual({ target: 'd', path: ['d'] });
  });

  it('descends back to the parent we came from on a merge commit', () => {
    // ascended d -> b (b is a child of d); descending must return to d, not parents[0]=c
    expect(computeNavigationTarget(jg, 'b', 'down', true)).toBe('c'); // baseline: stateless picks c
    expect(computeJumpTarget(jg, 'b', 'down', ['d', 'b'])).toEqual({ target: 'd', path: ['d'] });
  });

  it('retraces a multi-level descent one step per reverse jump', () => {
    // descend a -> b -> c -> e
    expect(computeJumpTarget(jg, 'a', 'down', [])).toEqual({ target: 'b', path: ['a', 'b'] });
    expect(computeJumpTarget(jg, 'b', 'down', ['a', 'b'])).toEqual({ target: 'c', path: ['a', 'b', 'c'] });
    expect(computeJumpTarget(jg, 'c', 'down', ['a', 'b', 'c'])).toEqual({ target: 'e', path: ['a', 'b', 'c', 'e'] });
    // ascend retraces e -> c -> b -> a
    expect(computeJumpTarget(jg, 'e', 'up', ['a', 'b', 'c', 'e'])).toEqual({ target: 'c', path: ['a', 'b', 'c'] });
    expect(computeJumpTarget(jg, 'c', 'up', ['a', 'b', 'c'])).toEqual({ target: 'b', path: ['a', 'b'] });
    expect(computeJumpTarget(jg, 'b', 'up', ['a', 'b'])).toEqual({ target: 'a', path: ['a'] });
  });

  it('re-anchors when the path tail does not match the current selection', () => {
    // stale path [a, b]; current is c -> treated as fresh [c], then push first parent e
    expect(computeJumpTarget(jg, 'c', 'down', ['a', 'b'])).toEqual({ target: 'e', path: ['c', 'e'] });
  });

  it('takes the default and pushes when prev is not a loaded neighbor', () => {
    // prev 'z' is not in the list -> not a retrace; ascend default newest child of c is b
    expect(computeJumpTarget(jg, 'c', 'up', ['z', 'c'])).toEqual({ target: 'b', path: ['z', 'c', 'b'] });
  });

  it('drops the oldest entry when the path exceeds maxPath', () => {
    // prev 'a' is not a parent of b -> default parents[0]=c pushed; cap 2 keeps the last two
    expect(computeJumpTarget(jg, 'b', 'down', ['a', 'b'], 2)).toEqual({ target: 'c', path: ['b', 'c'] });
  });

  it('no-ops and preserves the path when the first parent is not loaded', () => {
    // e has no parents
    expect(computeJumpTarget(jg, 'e', 'down', ['d', 'e'])).toEqual({ target: null, path: ['d', 'e'] });
  });

  it('no-ops and preserves the path when there is no loaded child', () => {
    // a has no children
    expect(computeJumpTarget(jg, 'a', 'up', ['a'])).toEqual({ target: null, path: ['a'] });
  });
});

describe('isRowOffscreen', () => {
  it('row above the viewport is offscreen', () => {
    // row 0 spans 0..30px; viewport is 300..900
    expect(isRowOffscreen(0, 30, 300, 600)).toBe(true);
  });

  it('row below the viewport is offscreen', () => {
    // row 40 spans 1200..1230px; viewport is 0..600
    expect(isRowOffscreen(40, 30, 0, 600)).toBe(true);
  });

  it('row inside the viewport is on-screen', () => {
    // row 10 spans 300..330px; viewport is 0..600
    expect(isRowOffscreen(10, 30, 0, 600)).toBe(false);
  });

  it('a partially visible row counts as on-screen', () => {
    // row 20 spans 600..630px; viewport is 0..610 (overlaps 600..610)
    expect(isRowOffscreen(20, 30, 0, 610)).toBe(false);
  });

  it('a negative index (no HEAD) is never offscreen', () => {
    expect(isRowOffscreen(-1, 30, 0, 600)).toBe(false);
  });
});
