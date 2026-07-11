import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { workbenchStore } from '../workbench-store.svelte';
import { postCommit, listenForHostMessages } from '../messaging';

listenForHostMessages();

beforeEach(() => {
  workbenchStore.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('postCommit timeout fallback', () => {
  it('clears committing and surfaces a soft error if no reply ever arrives', () => {
    postCommit(false);
    expect(workbenchStore.committing).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(workbenchStore.committing).toBe(false);
    expect(workbenchStore.commitError).toBeTruthy();
  });

  it('does not fire the timeout once a terminal reply arrived', () => {
    postCommit(false);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'workbenchCommitResult', payload: { results: [] } },
    }));
    expect(workbenchStore.committing).toBe(false);

    vi.advanceTimersByTime(30_000);

    expect(workbenchStore.commitError).toBeNull();
  });
});
