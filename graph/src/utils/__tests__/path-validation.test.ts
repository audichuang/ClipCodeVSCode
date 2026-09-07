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

  /* SNIPCODE-HOOK start: `..name` is a file, not traversal. The guard compared
     the PREFIX, so these ordinary repo-root files had their diff refused — and
     one of them failed a whole multi-diff batch with it. */
  it('resolves files whose name merely starts with dots', () => {
    expect(resolveRepoRelativePath(repo, '..keep', 'op')).toBe(path.join(repo, '..keep'));
    expect(resolveRepoRelativePath(repo, '..hidden/a.ts', 'op')).toBe(path.join(repo, '..hidden/a.ts'));
    expect(resolveRepoRelativePath(repo, 'src/..data', 'op')).toBe(path.join(repo, 'src/..data'));
  });
  /* SNIPCODE-HOOK end */

  it('rejects the bare parent directory', () => {
    expect(() => resolveRepoRelativePath(repo, '..', 'op')).toThrow(/escapes repository/);
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
