import { describe, it, expect } from 'vitest';
import { SequenceGuard } from '../sequence-guard';

describe('SequenceGuard', () => {
  it('the freshest ticket wins', () => {
    const guard = new SequenceGuard();
    const t1 = guard.issue();
    const t2 = guard.issue();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });

  it('issuing without checking still increments', () => {
    const guard = new SequenceGuard();
    const t1 = guard.issue();
    guard.issue();
    guard.issue();
    expect(guard.isCurrent(t1)).toBe(false);
  });

  it('reset() invalidates all previously issued tickets', () => {
    const guard = new SequenceGuard();
    const t = guard.issue();
    expect(guard.isCurrent(t)).toBe(true);
    guard.reset();
    expect(guard.isCurrent(t)).toBe(false);
  });

  it('after reset(), newly issued tickets are valid again', () => {
    const guard = new SequenceGuard();
    guard.issue();
    guard.reset();
    const t = guard.issue();
    expect(guard.isCurrent(t)).toBe(true);
  });

  it('an unissued/foreign ticket is never current', () => {
    const guard = new SequenceGuard();
    guard.issue();
    expect(guard.isCurrent(999)).toBe(false);
    expect(guard.isCurrent(0)).toBe(false);
  });
});
