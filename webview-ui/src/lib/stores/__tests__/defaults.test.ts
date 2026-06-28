import { describe, it, expect, beforeEach } from 'vitest';
import { resolveDefaults, defaultsStore } from '../defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../defaults-shape';

describe('resolveDefaults', () => {
  it('returns the hardcoded defaults when given nothing', () => {
    expect(resolveDefaults(undefined)).toEqual(DEFAULT_MODAL_DEFAULTS);
  });

  it('fills missing fields in a partial modal object from fallbacks', () => {
    const out = resolveDefaults({ push: { force: 'force' } } as any);
    expect(out.push).toEqual({ force: 'force', setUpstream: true, allTags: false });
  });

  it('rejects an invalid enum value and falls back to the default', () => {
    const out = resolveDefaults({ reset: { mode: 'nuke' } } as any);
    expect(out.reset.mode).toBe('mixed');
  });

  it('coerces non-boolean values to the fallback boolean', () => {
    const out = resolveDefaults({ pull: { rebase: 'yes' } } as any);
    expect(out.pull.rebase).toBe(true); // fallback, not truthy-coerced
  });

  it('ignores unknown modal keys', () => {
    const out = resolveDefaults({ bogus: { x: 1 } } as any);
    expect(out).toEqual(DEFAULT_MODAL_DEFAULTS);
  });

  it('accepts a real boolean override for a boolean field', () => {
    const out = resolveDefaults({ pull: { rebase: false, stash: true } } as any);
    expect(out.pull.rebase).toBe(false);
    expect(out.pull.stash).toBe(true);
  });
});

describe('defaultsStore', () => {
  beforeEach(() => {
    defaultsStore.set(undefined); // reset to hardcoded defaults
  });

  it('starts at the hardcoded defaults', () => {
    expect(defaultsStore.current).toEqual(DEFAULT_MODAL_DEFAULTS);
  });

  it('set() normalizes and stores the resolved defaults', () => {
    defaultsStore.set({ push: { force: 'with-lease' } } as any);
    expect(defaultsStore.current.push.force).toBe('with-lease');
    // Unspecified fields still come from the fallbacks.
    expect(defaultsStore.current.push.setUpstream).toBe(true);
  });

  it('set() with junk falls back entirely to the defaults', () => {
    defaultsStore.set({ push: { force: 'with-lease' } } as any);
    defaultsStore.set('not an object');
    expect(defaultsStore.current).toEqual(DEFAULT_MODAL_DEFAULTS);
  });
});
