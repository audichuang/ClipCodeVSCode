import { describe, it, expect, beforeEach } from 'vitest';
import { workbenchStore } from '../workbench-store.svelte';

beforeEach(() => workbenchStore.reset());

describe('CommitBoxStore', () => {
  it('canCommit requires a non-empty message and not committing', () => {
    expect(workbenchStore.canCommit).toBe(false);
    workbenchStore.message = '修正手續費';
    expect(workbenchStore.canCommit).toBe(true);
    workbenchStore.committing = true;
    expect(workbenchStore.canCommit).toBe(false);
  });

  it('clears the message and committing when every repo committed cleanly', () => {
    workbenchStore.message = 'msg';
    workbenchStore.committing = true;
    workbenchStore.applyCommitResults([{ repoName: 'a', ok: true }, { repoName: 'b', ok: true }]);
    expect(workbenchStore.message).toBe('');
    expect(workbenchStore.committing).toBe(false);
  });

  it('keeps the message on any failure so the user can retry', () => {
    workbenchStore.message = 'msg';
    workbenchStore.committing = true;
    workbenchStore.applyCommitResults([{ repoName: 'a', ok: true }, { repoName: 'b', ok: false, error: 'hook failed' }]);
    expect(workbenchStore.message).toBe('msg');
    expect(workbenchStore.committing).toBe(false);
    expect(workbenchStore.results.find((r) => !r.ok)?.error).toBe('hook failed');
  });
});
