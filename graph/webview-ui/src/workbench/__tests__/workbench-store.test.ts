import { describe, it, expect, beforeEach } from 'vitest';
import { workbenchStore, type WbStatus } from '../workbench-store.svelte';

const status: WbStatus = {
  repos: [
    {
      repoPath: '/a', repoName: 'a', operationState: 'clean', indexDirty: false,
      detached: false, commitDisabledReason: null,
      files: [
        { path: 'x.ts', changeType: 'M', hunkCount: 2, hunkable: true },
        { path: 'y.ts', changeType: 'A', hunkCount: 1, hunkable: true },
      ],
    },
    {
      repoPath: '/b', repoName: 'b', operationState: 'merge', indexDirty: false,
      detached: false, commitDisabledReason: '此 repo 有進行中的 merge，請先完成或中止',
      files: [{ path: 'z.ts', changeType: 'M', hunkCount: 1, hunkable: true }],
    },
  ],
};

beforeEach(() => {
  workbenchStore.reset();
  workbenchStore.setStatus(status);
  workbenchStore.message = '';
});

describe('workbenchStore selection', () => {
  it('toggles a file and reflects tri-state on its repo', () => {
    expect(workbenchStore.repoTriState('/a')).toBe('none');
    workbenchStore.toggleFile('/a', 'x.ts');
    expect(workbenchStore.repoTriState('/a')).toBe('some');
    workbenchStore.toggleFile('/a', 'y.ts');
    expect(workbenchStore.repoTriState('/a')).toBe('all');
  });

  it('toggleRepo selects/deselects all files in a repo', () => {
    workbenchStore.toggleRepo('/a');
    expect(workbenchStore.repoTriState('/a')).toBe('all');
    workbenchStore.toggleRepo('/a');
    expect(workbenchStore.repoTriState('/a')).toBe('none');
  });

  it('ignores toggles on a commit-disabled repo', () => {
    workbenchStore.toggleFile('/b', 'z.ts');
    expect(workbenchStore.repoTriState('/b')).toBe('none');
  });

  it('selections() yields only checked repos with hunk counts', () => {
    workbenchStore.toggleFile('/a', 'x.ts');
    expect(workbenchStore.selections()).toEqual([
      { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 2 }] },
    ]);
  });

  it('canCommit requires a selection; canAmend requires a single repo', () => {
    expect(workbenchStore.canCommit).toBe(false);
    workbenchStore.toggleFile('/a', 'x.ts');
    expect(workbenchStore.canCommit).toBe(true);
    expect(workbenchStore.canAmend).toBe(true); // single repo /a
  });

  it('setStatus preserves an existing selection for files that still exist', () => {
    workbenchStore.toggleFile('/a', 'x.ts');
    workbenchStore.setStatus(status); // refresh with same files
    expect(workbenchStore.repoTriState('/a')).toBe('some');
  });

  it('setStatus drops a selection for a repo that just became commit-disabled', () => {
    workbenchStore.toggleFile('/a', 'x.ts');
    expect(workbenchStore.repoTriState('/a')).toBe('some');
    workbenchStore.setStatus({
      repos: [
        { ...status.repos[0], commitDisabledReason: '此 repo 有進行中的 merge，請先完成或中止' },
        status.repos[1],
      ],
    });
    expect(workbenchStore.repoTriState('/a')).toBe('none');
    expect(workbenchStore.selections()).toEqual([]);
  });

  it('applyCommitResults clears selection for succeeded repos, keeps failed', () => {
    workbenchStore.toggleFile('/a', 'x.ts');
    workbenchStore.applyCommitResults([{ repoPath: '/a', ok: false, error: 'hook' }]);
    expect(workbenchStore.repoTriState('/a')).toBe('some'); // kept on failure
    workbenchStore.applyCommitResults([{ repoPath: '/a', ok: true, newHead: 'h' }]);
    expect(workbenchStore.repoTriState('/a')).toBe('none'); // cleared on success
  });
});
