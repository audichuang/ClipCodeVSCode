import { describe, it, expect, beforeEach } from 'vitest';
import { commitStore } from '../commits.svelte';
import type { Commit, GraphNode, CommitGraphData } from '../../types';

function makeCommit(hash: string): Commit {
  return {
    hash,
    abbreviatedHash: hash.substring(0, 7),
    author: { name: 'A', email: 'a@x', date: '2024-01-01' },
    committer: { name: 'A', email: 'a@x', date: '2024-01-01' },
    subject: `c ${hash}`,
    body: '',
    parents: [],
    refs: [],
  };
}

function makeNode(hash: string, column = 0): GraphNode {
  return { commit: hash, column, color: '#000', parents: [] };
}

const emptyData: CommitGraphData = { commits: [], graph: [] };

beforeEach(() => {
  commitStore.setData(emptyData);
  commitStore.setLoading(false);
  commitStore.setLoadingMore(false);
});

describe('commitStore.setData', () => {
  it('clears loading flags after data arrives', () => {
    commitStore.setLoading(true);
    commitStore.setLoadingMore(true);
    commitStore.setData(emptyData);
    expect(commitStore.loading).toBe(false);
    expect(commitStore.loadingMore).toBe(false);
  });

  it('preserves currentLimit when omitted from payload (do not reset paging on refresh)', () => {
    commitStore.setData({ ...emptyData, currentLimit: 500 });
    commitStore.setData(emptyData); // refresh with no currentLimit
    expect(commitStore.currentLimit).toBe(500);
  });

  it('defaults optional graph fields to []', () => {
    commitStore.setData({ commits: [], graph: [] });
    expect(commitStore.paths).toEqual([]);
    expect(commitStore.links).toEqual([]);
    expect(commitStore.dots).toEqual([]);
    expect(commitStore.commitLeftMargin).toEqual([]);
  });

  it('clears notGitRepo flag whenever data arrives', () => {
    commitStore.notGitRepo = true;
    commitStore.setData(emptyData);
    expect(commitStore.notGitRepo).toBe(false);
  });
});

describe('commitStore lookups', () => {
  beforeEach(() => {
    commitStore.setData({
      commits: [makeCommit('aaa'), makeCommit('bbb')],
      graph: [makeNode('aaa', 0), makeNode('bbb', 1)],
    });
  });

  it('getCommit finds by hash', () => {
    expect(commitStore.getCommit('bbb')?.hash).toBe('bbb');
  });

  it('getCommit returns undefined for unknown hash', () => {
    expect(commitStore.getCommit('zzz')).toBeUndefined();
  });

  it('getGraphNode finds by commit hash', () => {
    expect(commitStore.getGraphNode('bbb')?.column).toBe(1);
  });

  it('getGraphNode returns undefined for unknown hash', () => {
    expect(commitStore.getGraphNode('zzz')).toBeUndefined();
  });

  it('rebuilds lookup indexes when setData is called again (stale entries must vanish)', () => {
    expect(commitStore.getCommit('aaa')?.hash).toBe('aaa');
    expect(commitStore.getGraphNode('aaa')?.column).toBe(0);
    commitStore.setData({
      commits: [makeCommit('ccc')],
      graph: [makeNode('ccc', 5)],
    });
    expect(commitStore.getCommit('aaa')).toBeUndefined();
    expect(commitStore.getGraphNode('aaa')).toBeUndefined();
    expect(commitStore.getCommit('ccc')?.hash).toBe('ccc');
    expect(commitStore.getGraphNode('ccc')?.column).toBe(5);
  });

  it('commitMap exposes a hash→Commit map for bulk lookups', () => {
    const map = commitStore.commitMap;
    expect(map.size).toBe(2);
    expect(map.get('aaa')?.hash).toBe('aaa');
    expect(map.get('bbb')?.hash).toBe('bbb');
    expect(map.get('zzz')).toBeUndefined();
  });
});

describe('commitStore.headHash', () => {
  it('returns the hash of the commit carrying a head ref', () => {
    const head = makeCommit('h1');
    head.refs = [{ type: 'head', name: 'HEAD' }];
    commitStore.commits = [makeCommit('h0'), head];
    expect(commitStore.headHash).toBe('h1');
  });

  it('returns null when no commit carries a head ref', () => {
    commitStore.commits = [makeCommit('h0'), makeCommit('h1')];
    expect(commitStore.headHash).toBeNull();
  });
});
