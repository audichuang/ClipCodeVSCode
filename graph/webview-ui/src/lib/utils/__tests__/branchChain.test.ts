import { describe, it, expect } from 'vitest';
import type { Commit } from '../../types';
import { chainBranches } from '../branchChain';

function mkCommit(hash: string, parents: string[]): Commit {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    author: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    committer: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    subject: `s-${hash}`,
    body: '',
    parents,
    refs: [],
  };
}

// feature: c -> b -> a -> r   (tip=c)
// hotfix:  e -> d -> b -> a -> r   (분기점 b, tip=e)
// main:    a -> r   (tip=a)
function graph(): Map<string, Commit> {
  const list = [
    mkCommit('c', ['b']),
    mkCommit('b', ['a']),
    mkCommit('a', ['r']),
    mkCommit('e', ['d']),
    mkCommit('d', ['b']),
  ];
  return new Map(list.map(c => [c.hash, c]));
}

const tips = [
  { name: 'feature', hash: 'c' },
  { name: 'hotfix', hash: 'e' },
  { name: 'main', hash: 'a' },
];

describe('chainBranches', () => {
  it('returns the single branch whose first-parent line reaches the head', () => {
    expect(chainBranches('c', graph(), tips)).toEqual(['feature']);
  });

  it('returns multiple branches when the head is a shared first-parent ancestor', () => {
    expect(chainBranches('b', graph(), tips).sort()).toEqual(['feature', 'hotfix']);
  });

  it('returns empty when no branch tip reaches the head in the loaded set', () => {
    expect(chainBranches('z', graph(), tips)).toEqual([]);
  });

  it('returns empty for a branch whose tip is outside the loaded commit set', () => {
    expect(chainBranches('a', graph(), [{ name: 'gone', hash: 'missing' }])).toEqual([]);
  });
});
