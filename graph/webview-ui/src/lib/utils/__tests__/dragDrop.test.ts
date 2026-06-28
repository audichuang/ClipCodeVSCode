import { describe, it, expect } from 'vitest';
import { resolveDrop, dragRebaseMessage, dragMergeMessage } from '../dragDrop';

const locals = new Set(['main', 'feature', 'develop']);

describe('resolveDrop', () => {
  it('ignores an empty source or target', () => {
    expect(resolveDrop('', 'main', locals)).toEqual({ kind: 'ignore' });
    expect(resolveDrop('feature', '', locals)).toEqual({ kind: 'ignore' });
  });

  it('ignores when source or target is not a local branch', () => {
    expect(resolveDrop('feature', 'origin/main', locals)).toEqual({ kind: 'ignore' });
    expect(resolveDrop('v1.0', 'main', locals)).toEqual({ kind: 'ignore' });
  });

  it('ignores dropping a branch onto itself', () => {
    expect(resolveDrop('feature', 'feature', locals)).toEqual({ kind: 'ignore' });
  });

  it('returns a menu resolution for a valid local->local drop', () => {
    expect(resolveDrop('feature', 'main', locals)).toEqual({ kind: 'menu', source: 'feature', target: 'main' });
  });
});

describe('drag message builders', () => {
  it('builds a dragRebase message without dirty options by default', () => {
    expect(dragRebaseMessage('feature', 'main')).toEqual({ type: 'dragRebase', payload: { source: 'feature', target: 'main' } });
  });

  it('builds a dragMerge message without dirty options by default', () => {
    expect(dragMergeMessage('feature', 'main')).toEqual({ type: 'dragMerge', payload: { source: 'feature', target: 'main' } });
  });

  it('spreads a dirty payload into the dragRebase message', () => {
    expect(dragRebaseMessage('feature', 'main', { stash: true, stashUntracked: true })).toEqual({
      type: 'dragRebase', payload: { source: 'feature', target: 'main', stash: true, stashUntracked: true },
    });
  });
});
