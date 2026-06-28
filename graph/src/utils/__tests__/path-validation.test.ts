import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveRepoRelativePath, assertSafeArgPath } from '../path-validation';

const repo = path.resolve('/tmp/repo');

describe('resolveRepoRelativePath', () => {
  it('resolves a normal relative path under the repo', () => {
    expect(resolveRepoRelativePath(repo, 'src/index.ts', 'op')).toBe(
      path.join(repo, 'src/index.ts')
    );
  });

  it('resolves the empty-segment path "." to the repo root', () => {
    expect(resolveRepoRelativePath(repo, '.', 'op')).toBe(repo);
  });

  it('rejects parent traversal', () => {
    expect(() => resolveRepoRelativePath(repo, '../etc/passwd', 'op')).toThrow(
      /escapes repository/
    );
  });

  it('rejects nested parent traversal that still escapes', () => {
    expect(() => resolveRepoRelativePath(repo, 'a/../../b', 'op')).toThrow(
      /escapes repository/
    );
  });

  it('rejects absolute paths outside the repo', () => {
    expect(() => resolveRepoRelativePath(repo, '/etc/passwd', 'op')).toThrow(
      /escapes repository/
    );
  });

  it('rejects non-string input', () => {
    expect(() => resolveRepoRelativePath(repo, undefined, 'op')).toThrow(
      /Invalid path/
    );
    expect(() => resolveRepoRelativePath(repo, 123, 'op')).toThrow(/Invalid path/);
  });

  it('rejects empty string', () => {
    expect(() => resolveRepoRelativePath(repo, '', 'op')).toThrow(/Invalid path/);
  });
});

describe('assertSafeArgPath', () => {
  it('returns the path unchanged for safe inputs', () => {
    expect(assertSafeArgPath('foo/bar', 'op')).toBe('foo/bar');
  });

  it('rejects values that start with a hyphen (option-like)', () => {
    expect(() => assertSafeArgPath('--upload-pack=evil', 'op')).toThrow(
      /may not start with '-'/
    );
  });

  it('rejects non-string input', () => {
    expect(() => assertSafeArgPath(undefined, 'op')).toThrow(/Invalid path/);
  });

  it('rejects empty string', () => {
    expect(() => assertSafeArgPath('', 'op')).toThrow(/Invalid path/);
  });
});
