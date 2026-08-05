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
  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  it('tracks the checked staged-repo count sent by the host', () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'workbenchCommitState', payload: { stagedRepoCount: 2 } },
    }));

    expect(workbenchStore.stagedRepoCount).toBe(2);
  });

  it('announces readiness so the host replays the initial commit state', () => {
    globalThis.__postedMessages = [];

    listenForHostMessages();

    expect(globalThis.__postedMessages).toContainEqual({ data: { type: 'workbenchReady' } });
  });
  /* SNIPCODE-HOOK end */

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
