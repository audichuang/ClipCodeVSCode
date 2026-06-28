import { describe, it, expect } from 'vitest';
import type { Commit } from '../../types';
import { getSquashChain, buildDefaultSquashMessage, buildSquashTodos } from '../squash';

function mkCommit(hash: string, parents: string[], subject = `subject-${hash}`, body = ''): Commit {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    author: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    committer: { name: 'a', email: 'a@b.c', date: '2024-01-01' },
    subject,
    body,
    parents,
    refs: [],
  };
}

// Linear history (newest → oldest): e → d → c → b → a → (root parent "r")
function linearMap(): Map<string, Commit> {
  const commits = [
    mkCommit('e', ['d']),
    mkCommit('d', ['c']),
    mkCommit('c', ['b']),
    mkCommit('b', ['a']),
    mkCommit('a', ['r']),
  ];
  return new Map(commits.map(c => [c.hash, c]));
}

describe('getSquashChain', () => {
  it('returns the chain oldest→newest for a contiguous linear selection', () => {
    const chain = getSquashChain(['d', 'b', 'c'], linearMap());
    expect(chain?.map(c => c.hash)).toEqual(['b', 'c', 'd']);
  });

  it('returns null for fewer than two commits', () => {
    expect(getSquashChain(['c'], linearMap())).toBeNull();
    expect(getSquashChain([], linearMap())).toBeNull();
  });

  it('returns null when the selection is not contiguous', () => {
    // b and d are selected but c (between them) is not → gap
    expect(getSquashChain(['b', 'd'], linearMap())).toBeNull();
  });

  it('returns null when the oldest selected commit has no parent (root)', () => {
    const map = new Map([
      mkCommit('b', ['a']),
      mkCommit('a', []), // root: no parent
    ].map(c => [c.hash, c]));
    expect(getSquashChain(['a', 'b'], map)).toBeNull();
  });

  it('returns null when a selected commit is a merge commit', () => {
    const map = new Map([
      mkCommit('m', ['d', 'x']), // merge: two parents
      mkCommit('d', ['c']),
      mkCommit('c', ['b']),
      mkCommit('b', ['a']),
    ].map(c => [c.hash, c]));
    expect(getSquashChain(['c', 'd', 'm'], map)).toBeNull();
  });

  it('returns null when a selected hash is unknown', () => {
    expect(getSquashChain(['c', 'zzz'], linearMap())).toBeNull();
  });
});

describe('buildDefaultSquashMessage', () => {
  it('joins subjects oldest→newest with blank lines', () => {
    const chain = [mkCommit('a', ['r'], 'first'), mkCommit('b', ['a'], 'second')];
    expect(buildDefaultSquashMessage(chain)).toBe('first\n\nsecond');
  });

  it('includes commit bodies after their subject', () => {
    const chain = [
      mkCommit('a', ['r'], 'first', 'body of first'),
      mkCommit('b', ['a'], 'second'),
    ];
    expect(buildDefaultSquashMessage(chain)).toBe('first\n\nbody of first\n\nsecond');
  });
});

describe('buildSquashTodos', () => {
  // rebaseCommits = base..HEAD oldest→newest. base = a^ = r, so range r..HEAD = a,b,c,d,e
  function rebaseCommits(): Commit[] {
    return ['a', 'b', 'c', 'd', 'e'].map(h => {
      const m = linearMap().get(h)!;
      return m;
    });
  }

  it('marks the oldest selected as pick with the final message and others as fixup', () => {
    const todos = buildSquashTodos(rebaseCommits(), ['b', 'c', 'd'], 'b', 'combined msg');
    expect(todos).toEqual([
      { action: 'pick', hash: 'a', subject: 'subject-a' },
      { action: 'pick', hash: 'b', subject: 'subject-b', message: 'combined msg' },
      { action: 'fixup', hash: 'c', subject: 'subject-c' },
      { action: 'fixup', hash: 'd', subject: 'subject-d' },
      { action: 'pick', hash: 'e', subject: 'subject-e' },
    ]);
  });
});
