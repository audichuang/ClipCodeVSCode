import { describe, it, expect, beforeEach } from 'vitest';
import { workbenchStore } from '../workbench-store.svelte';

beforeEach(() => workbenchStore.reset());

describe('CommitBoxStore', () => {
  it('canCommit requires a non-empty message and not committing', () => {
    workbenchStore.commitScopeReady = true;
    expect(workbenchStore.canCommit).toBe(false);
    workbenchStore.message = '修正手續費';
    expect(workbenchStore.canCommit).toBe(true);
    workbenchStore.committing = true;
    expect(workbenchStore.canCommit).toBe(false);
  });

  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  it('canAmend requires exactly one checked repo with staged changes', () => {
    workbenchStore.commitScopeReady = true;
    workbenchStore.message = '修正手續費';
    workbenchStore.stagedRepoCount = 2;
    expect(workbenchStore.canCommit).toBe(true);
    expect(workbenchStore.canAmend).toBe(false);

    workbenchStore.stagedRepoCount = 1;
    expect(workbenchStore.canAmend).toBe(true);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S13 Amend prefill */
  it('canAmend does not require a message (an empty one triggers prefill, not disabled)', () => {
    workbenchStore.commitScopeReady = true;
    workbenchStore.message = '';
    workbenchStore.stagedRepoCount = 1;
    expect(workbenchStore.canCommit).toBe(false);
    expect(workbenchStore.canAmend).toBe(true);
  });
  /* SNIPCODE-HOOK end */

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
