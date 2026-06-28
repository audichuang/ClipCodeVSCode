import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { uiStore } from '../ui.svelte';

beforeEach(() => {
  // Reset to defaults — singleton leaks between tests otherwise.
  uiStore.selectedCommitHash = null;
  uiStore.comparing = false;
  uiStore.compareRef1 = null;
  uiStore.compareRef2 = null;
  uiStore.showBottomPanel = false;
  uiStore.errorMessage = null;
  uiStore.viewMode = 'graph';
  uiStore.selectedCommitHashes = [];
  uiStore.anchorHash = null;
  uiStore.multiSelectArmed = false;
});

describe('uiStore.selectCommit', () => {
  it('updates selected hash and exits comparison mode', () => {
    uiStore.comparing = true;
    uiStore.compareRef1 = 'a';
    uiStore.compareRef2 = 'b';

    uiStore.selectCommit('abc123');

    expect(uiStore.selectedCommitHash).toBe('abc123');
    expect(uiStore.comparing).toBe(false);
    expect(uiStore.compareRef1).toBeNull();
    expect(uiStore.compareRef2).toBeNull();
  });

  it('opens the bottom panel when selecting a real commit', () => {
    uiStore.showBottomPanel = false;
    uiStore.selectCommit('abc123');
    expect(uiStore.showBottomPanel).toBe(true);
  });

  it('does NOT force-open the panel when deselecting (null)', () => {
    uiStore.showBottomPanel = false;
    uiStore.selectCommit(null);
    expect(uiStore.showBottomPanel).toBe(false);
  });
});

describe('uiStore.setViewMode', () => {
  it('switches to log view', () => {
    uiStore.setViewMode('log');
    expect(uiStore.viewMode).toBe('log');
  });

  it('switches to stats view', () => {
    uiStore.setViewMode('stats');
    expect(uiStore.viewMode).toBe('stats');
  });
});

describe('uiStore multi-select mode', () => {
  const order = ['c4', 'c3', 'c2', 'c1']; // newest → oldest

  it('enterMultiSelect arms the mode with one commit and no single-detail hash', () => {
    uiStore.enterMultiSelect('c3');
    expect(uiStore.multiSelectArmed).toBe(true);
    expect(uiStore.selectedCommitHashes).toEqual(['c3']);
    expect(uiStore.anchorHash).toBe('c3');
    expect(uiStore.selectedCommitHash).toBeNull();
  });

  it('toggleHash keeps selectedCommitHash null even at length 1 (armed mode)', () => {
    uiStore.enterMultiSelect('c3');
    uiStore.toggleHash('c3'); // remove → length 0
    expect(uiStore.selectedCommitHash).toBeNull();
    uiStore.toggleHash('c2'); // add → length 1
    expect(uiStore.selectedCommitHashes).toEqual(['c2']);
    expect(uiStore.selectedCommitHash).toBeNull();
  });

  it('selectRange builds an inclusive range and never sets single hash', () => {
    uiStore.enterMultiSelect('c4');
    uiStore.selectRange('c2', order);
    expect(uiStore.selectedCommitHashes).toEqual(['c4', 'c3', 'c2']);
    expect(uiStore.selectedCommitHash).toBeNull();
  });

  it('exitMultiSelect clears the mode and selection', () => {
    uiStore.enterMultiSelect('c4');
    uiStore.selectRange('c2', order);
    uiStore.exitMultiSelect();
    expect(uiStore.multiSelectArmed).toBe(false);
    expect(uiStore.selectedCommitHashes).toEqual([]);
    expect(uiStore.anchorHash).toBeNull();
    expect(uiStore.comparing).toBe(false);
  });

  it('selectCommit (plain) disarms the mode', () => {
    uiStore.enterMultiSelect('c4');
    uiStore.selectCommit('c2');
    expect(uiStore.multiSelectArmed).toBe(false);
    expect(uiStore.selectedCommitHash).toBe('c2');
    expect(uiStore.selectedCommitHashes).toEqual(['c2']);
  });

  it('selectRange stays armed when anchor was cleared', () => {
    const order = ['c4', 'c3', 'c2', 'c1'];
    uiStore.enterMultiSelect('c4');
    uiStore.toggleHash('c4');           // removes the only commit → anchor null, still armed
    uiStore.selectRange('c2', order);   // null-anchor fallback
    expect(uiStore.multiSelectArmed).toBe(true);   // must NOT disarm
    expect(uiStore.selectedCommitHashes).toEqual(['c2']);
    expect(uiStore.anchorHash).toBe('c2');
  });
});

describe('uiStore.modifierSelect', () => {
  const order = ['c4', 'c3', 'c2', 'c1']; // newest → oldest

  it('Ctrl-click while single-selected promotes to a two-commit multi-selection', () => {
    uiStore.selectCommit('c3');
    uiStore.modifierSelect('c2', { range: false, orderedHashes: order });
    expect(uiStore.multiSelectArmed).toBe(true);
    expect(uiStore.selectedCommitHashes).toEqual(['c3', 'c2']);
    expect(uiStore.selectedCommitHash).toBeNull();
  });

  it('Shift-click while single-selected selects the range from the prior selection', () => {
    uiStore.selectCommit('c4');
    uiStore.modifierSelect('c2', { range: true, orderedHashes: order });
    expect(uiStore.multiSelectArmed).toBe(true);
    expect(uiStore.selectedCommitHashes).toEqual(['c4', 'c3', 'c2']);
  });

  it('Ctrl-click with no prior selection arms with just that commit', () => {
    uiStore.modifierSelect('c2', { range: false, orderedHashes: order });
    expect(uiStore.multiSelectArmed).toBe(true);
    expect(uiStore.selectedCommitHashes).toEqual(['c2']);
  });

  it('modifier-click while already armed keeps building the selection', () => {
    uiStore.enterMultiSelect('c4');
    uiStore.modifierSelect('c2', { range: false, orderedHashes: order });
    expect(uiStore.selectedCommitHashes).toEqual(['c4', 'c2']);
  });
});

describe('uiStore.setError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the error message', () => {
    uiStore.setError('boom');
    expect(uiStore.errorMessage).toBe('boom');
  });

  it('clears the error after 8 seconds', () => {
    uiStore.setError('boom');
    vi.advanceTimersByTime(7999);
    expect(uiStore.errorMessage).toBe('boom');
    vi.advanceTimersByTime(1);
    expect(uiStore.errorMessage).toBeNull();
  });

  it('resets the timer when a new error arrives (does not let an old timer clear the new message)', () => {
    uiStore.setError('first');
    vi.advanceTimersByTime(7000);
    uiStore.setError('second');
    vi.advanceTimersByTime(7000);
    // 14s total since first error, but only 7s since the second one — must
    // still be visible. If the first timer wasn't cleared, the message
    // would have been wiped at t=8000.
    expect(uiStore.errorMessage).toBe('second');
    vi.advanceTimersByTime(1000);
    expect(uiStore.errorMessage).toBeNull();
  });

  it('clearing the error (null) stops any pending timer', () => {
    uiStore.setError('boom');
    uiStore.setError(null);
    vi.advanceTimersByTime(10000);
    expect(uiStore.errorMessage).toBeNull();
  });
});
