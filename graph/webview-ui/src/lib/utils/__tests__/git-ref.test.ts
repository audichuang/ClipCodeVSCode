import { describe, it, expect } from 'vitest';
import { validateGitRefName, isCommitHash, shortenRef } from '../git-ref';

describe('isCommitHash', () => {
  it('accepts 7-40 hex char strings', () => {
    expect(isCommitHash('abc1234')).toBe(true);
    expect(isCommitHash('a'.repeat(40))).toBe(true);
    expect(isCommitHash('DEADBEEF')).toBe(true);
  });
  it('rejects branch names and too-short/long or non-hex strings', () => {
    expect(isCommitHash('main')).toBe(false);
    expect(isCommitHash('abc123')).toBe(false); // 6 chars
    expect(isCommitHash('a'.repeat(41))).toBe(false);
    expect(isCommitHash('feature/xyz1234')).toBe(false);
  });
});

describe('shortenRef', () => {
  it('abbreviates a full 40-char hash to 7 chars', () => {
    const full = '0123456789abcdef0123456789abcdef01234567';
    expect(shortenRef(full)).toBe('0123456');
  });
  it('leaves branch names and short refs untouched', () => {
    expect(shortenRef('main')).toBe('main');
    expect(shortenRef('abc1234')).toBe('abc1234'); // not a full 40-char hash
  });
});

describe('validateGitRefName', () => {
  it('accepts normal branch names', () => {
    expect(validateGitRefName('main')).toBeNull();
    expect(validateGitRefName('feature/login')).toBeNull();
    expect(validateGitRefName('release-2024.01')).toBeNull();
    expect(validateGitRefName('user/jane/wip')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(validateGitRefName('')).toBe('gitRef.empty');
  });

  it('rejects exactly "@"', () => {
    expect(validateGitRefName('@')).toBe('gitRef.atOnly');
  });

  it('rejects whitespace and control characters', () => {
    expect(validateGitRefName('foo bar')).toBe('gitRef.whitespaceOrControl');
    expect(validateGitRefName('foo\tbar')).toBe('gitRef.whitespaceOrControl');
    expect(validateGitRefName('foo\nbar')).toBe('gitRef.whitespaceOrControl');
    expect(validateGitRefName('foo\x00bar')).toBe('gitRef.whitespaceOrControl');
    expect(validateGitRefName('foo\x7fbar')).toBe('gitRef.whitespaceOrControl');
  });

  it('rejects forbidden characters ^ ~ : ? * [ \\', () => {
    expect(validateGitRefName('foo^bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo~bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo:bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo?bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo*bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo[bar')).toBe('gitRef.forbiddenChars');
    expect(validateGitRefName('foo\\bar')).toBe('gitRef.forbiddenChars');
  });

  it('rejects the .. and @{ sequences', () => {
    expect(validateGitRefName('foo..bar')).toBe('gitRef.forbiddenSequence');
    expect(validateGitRefName('foo@{bar')).toBe('gitRef.forbiddenSequence');
  });

  it('rejects leading - . /', () => {
    expect(validateGitRefName('-foo')).toBe('gitRef.badStart');
    expect(validateGitRefName('.foo')).toBe('gitRef.badStart');
    expect(validateGitRefName('/foo')).toBe('gitRef.badStart');
  });

  it('rejects trailing . / .lock', () => {
    expect(validateGitRefName('foo.')).toBe('gitRef.badEnd');
    expect(validateGitRefName('foo/')).toBe('gitRef.badEnd');
    expect(validateGitRefName('foo.lock')).toBe('gitRef.badEnd');
  });

  it('rejects empty components (consecutive slashes)', () => {
    expect(validateGitRefName('foo//bar')).toBe('gitRef.badEnd');
  });

  it('rejects component starting with .', () => {
    expect(validateGitRefName('foo/.bar')).toBe('gitRef.badStart');
  });

  it('rejects component ending with .lock', () => {
    expect(validateGitRefName('foo.lock/bar')).toBe('gitRef.badEnd');
  });

  it('accepts dots inside a component', () => {
    expect(validateGitRefName('v1.2.3')).toBeNull();
    expect(validateGitRefName('feature/v1.0.0')).toBeNull();
  });
});
