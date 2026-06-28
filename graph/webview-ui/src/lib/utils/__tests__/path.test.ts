import { describe, it, expect } from 'vitest';
import { samePath } from '../path';

describe('samePath', () => {
  it('matches identical paths', () => {
    expect(samePath('/Users/me/proj', '/Users/me/proj')).toBe(true);
  });

  it('matches paths that differ only in separators (Windows fsPath vs git output)', () => {
    // git rev-parse --show-toplevel returns forward slashes; VS Code fsPath uses backslashes
    expect(samePath('c:/Users/me/projB', 'c:\\Users\\me\\projB')).toBe(true);
  });

  it('matches paths that differ only in drive-letter case', () => {
    expect(samePath('C:\\Users\\me\\projB', 'c:\\Users\\me\\projB')).toBe(true);
  });

  it('ignores a trailing slash', () => {
    expect(samePath('/Users/me/proj/', '/Users/me/proj')).toBe(true);
  });

  it('does not match different repositories', () => {
    expect(samePath('/Users/me/projA', '/Users/me/projB')).toBe(false);
  });

  it('returns false when either path is empty', () => {
    expect(samePath('', '/Users/me/proj')).toBe(false);
    expect(samePath('/Users/me/proj', '')).toBe(false);
  });
});
