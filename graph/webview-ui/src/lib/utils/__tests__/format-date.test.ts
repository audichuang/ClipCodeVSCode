import { describe, it, expect } from 'vitest';
import { formatCommitDate, formatCommitDateLong } from '../format-date';

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

// SNIPCODE-HOOK start: C10 — tooltip format, richer than the cell (full
// weekday + seconds) instead of repeating formatCommitDate's compact string.
describe('formatCommitDateLong', () => {
  it('formats a valid ISO date with more detail than formatCommitDate (weekday + seconds)', () => {
    const iso = '2024-01-15T10:00:00Z';
    const long = formatCommitDateLong(iso);
    expect(long.length).toBeGreaterThan(0);
    expect(long).toContain('2024');
    expect(long).toMatch(/:\d{2}:\d{2}(\s|$)/); // dateStyle:'full'/timeStyle:'medium' includes seconds
    expect(long).not.toBe(formatCommitDate(iso));
  });

  it('passes an empty/unparseable date through unchanged instead of throwing', () => {
    expect(() => formatCommitDateLong('')).not.toThrow();
    expect(formatCommitDateLong('')).toBe('');
    expect(formatCommitDateLong('not-a-date')).toBe('not-a-date');
  });
});
// SNIPCODE-HOOK end
