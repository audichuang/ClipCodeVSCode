import { describe, it, expect } from 'vitest';
import { dirtyPayload } from '../dirty-payload';

describe('dirtyPayload', () => {
  it('returns an empty payload when the tree is clean', () => {
    expect(dirtyPayload('stash', false)).toEqual({});
    expect(dirtyPayload('keep', false)).toEqual({});
  });

  it('maps stash to stash + stashUntracked', () => {
    expect(dirtyPayload('stash', true)).toEqual({ stash: true, stashUntracked: true });
  });

  it('maps discard to force + clean', () => {
    expect(dirtyPayload('discard', true)).toEqual({ force: true, clean: true });
  });

  it('maps keep to merge', () => {
    expect(dirtyPayload('keep', true)).toEqual({ merge: true });
  });
});
