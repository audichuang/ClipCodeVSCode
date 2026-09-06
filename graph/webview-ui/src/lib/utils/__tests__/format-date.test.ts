import { describe, it, expect } from 'vitest';
import { formatCommitDate } from '../format-date';

describe('formatCommitDate', () => {
  it('formats a valid ISO date as a non-empty, locale-aware string', () => {
    const out = formatCommitDate('2024-01-15T10:00:00Z');
    expect(out.length).toBeGreaterThan(0);
    // dateStyle:'medium' includes the year; timeStyle:'short' has no seconds.
    expect(out).toContain('2024');
    expect(out).not.toMatch(/:\d{2}:\d{2}(\s|$)/); // no seconds component
  });

  it('passes an empty date (the synthetic UNCOMMITTED commit) through unchanged instead of throwing', () => {
    expect(() => formatCommitDate('')).not.toThrow();
    expect(formatCommitDate('')).toBe('');
  });

  it('passes an unparseable date string through unchanged instead of throwing', () => {
    expect(() => formatCommitDate('not-a-date')).not.toThrow();
    expect(formatCommitDate('not-a-date')).toBe('not-a-date');
  });
});
