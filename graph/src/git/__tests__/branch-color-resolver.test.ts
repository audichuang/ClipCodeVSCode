import { describe, it, expect } from 'vitest';
import { compileBranchColorRules, makeBranchColorResolver } from '../branch-color-resolver';

describe('compileBranchColorRules', () => {
  it('compiles valid rules into regex + color', () => {
    const rules = compileBranchColorRules([
      { pattern: '^main$', color: '#00FF00' },
      { pattern: '.+/hotfix/.+', color: '#ffea00' },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0].regex.test('main')).toBe(true);
    expect(rules[0].color).toBe('#00FF00');
  });

  it('accepts 3-digit hex and skips invalid colors', () => {
    const rules = compileBranchColorRules([
      { pattern: 'a', color: '#0f0' },
      { pattern: 'b', color: 'red' },
      { pattern: 'c', color: '#12' },
    ]);
    expect(rules.map(r => r.color)).toEqual(['#0f0']);
  });

  it('skips entries with invalid regex or missing fields', () => {
    const rules = compileBranchColorRules([
      { pattern: '[', color: '#000000' },
      { pattern: 'ok', color: '#000000' },
      { color: '#000000' },
      'nonsense',
      null,
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].regex.test('ok')).toBe(true);
  });

  it('returns empty array for non-array input', () => {
    expect(compileBranchColorRules(undefined)).toEqual([]);
    expect(compileBranchColorRules({})).toEqual([]);
  });
});

describe('makeBranchColorResolver', () => {
  it('returns the first matching rule color (declaration order wins)', () => {
    const resolve = makeBranchColorResolver(compileBranchColorRules([
      { pattern: 'feat/.*', color: '#111111' },
      { pattern: 'feat/special', color: '#222222' },
    ]));
    expect(resolve('feat/special')).toBe('#111111');
  });

  it('returns undefined when nothing matches', () => {
    const resolve = makeBranchColorResolver(compileBranchColorRules([
      { pattern: '^main$', color: '#00FF00' },
    ]));
    expect(resolve('dev')).toBeUndefined();
  });
});
