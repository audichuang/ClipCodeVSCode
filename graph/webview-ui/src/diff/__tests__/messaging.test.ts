import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diffStore } from '../diff-store.svelte';
import { listenForHostMessages, postStageHunk, postStageLines } from '../messaging';
import { i18n } from '../../lib/i18n/index.svelte';

const emptyDiff = { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] };

beforeEach(() => {
  diffStore.reset();
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
});

afterEach(() => vi.useRealTimers());

describe('diff messaging', () => {
  it('diffShow populates both sides of the store', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: emptyDiff, unstagedDiff: null } },
    }));
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.stagedDiff).not.toBeNull();
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.loaded).toBe(true);
  });

  it('setLocale switches the i18n locale', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setLocale', payload: { locale: 'zh-cn' } },
    }));
    expect(i18n.locale).toBe('zh');
  });

  it('postStageHunk posts diffStageHunk with the given side', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 2);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageHunk', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 2 } },
    });
  });

  it('postStageHunk on the staged side posts side:staged', () => {
    diffStore.setDiffs('/r', 'src/a.ts', emptyDiff, null);
    postStageHunk('staged', 0);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageHunk', payload: { repoPath: '/r', file: 'src/a.ts', side: 'staged', hunkIndex: 0 } },
    });
  });

  it('postStageHunk is dropped when the requested side has no diff', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff); // staged is null
    postStageHunk('staged', 0);
    expect(globalThis.__postedMessages).toHaveLength(0);
  });

  it('an error message for diffStageHunk sets store.error', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.error).toBe('nope');
  });

  it('postStageHunk sets busy and ignores a second call until unlocked', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    postStageHunk('unstaged', 1); // dropped: an op is already in flight
    expect(globalThis.__postedMessages).toHaveLength(1);
  });

  it('diffShow clears busy so the next stage click is allowed again', () => {
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: null, unstagedDiff: emptyDiff } },
    }));
    expect(diffStore.busy).toBe(false);
  });

  it('an error reply also clears busy', () => {
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.busy).toBe(false);
  });

  it('postStageLines posts diffStageLines with side + indices', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageLines('unstaged', 0, [1, 2]);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageLines', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 0, lineIndices: [1, 2] } },
    });
  });

  it('postStageLines is gated by a missing side and by busy, like postStageHunk', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageLines('staged', 0, [1]); // staged side is null → dropped
    expect(globalThis.__postedMessages).toHaveLength(0);
    postStageLines('unstaged', 0, [1]);
    postStageLines('unstaged', 1, [2]); // an op is already in flight → dropped
    expect(globalThis.__postedMessages).toHaveLength(1);
  });

  it('a slow reply times out into a banner but keeps stage locked until the fresh diffShow', () => {
    vi.useFakeTimers();
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    vi.advanceTimersByTime(15_000);
    // Still locked: the op may still be running host-side and the shown hunk
    // indices are stale — unlocking here could stage the wrong hunk.
    expect(diffStore.busy).toBe(true);
    expect(diffStore.error).toContain('longer than expected');
    postStageHunk('unstaged', 1); // must still be refused
    expect(globalThis.__postedMessages).toHaveLength(1);
    // The late diffShow finally unlocks and clears the banner.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: null, unstagedDiff: emptyDiff } },
    }));
    expect(diffStore.busy).toBe(false);
    expect(diffStore.error).toBeNull();
  });

  it('a diffShow reply disarms the timeout', () => {
    vi.useFakeTimers();
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: null, unstagedDiff: emptyDiff } },
    }));
    vi.advanceTimersByTime(60_000);
    expect(diffStore.busy).toBe(false);
    expect(diffStore.error).toBeNull();
  });
});
