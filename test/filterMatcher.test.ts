import assert from 'node:assert/strict';
import test from 'node:test';
import { fileMatchesFilters, matchesPath, overlapsDirectory } from '../src/filterMatcher.js';

test('path matching is segment aware', () => {
  assert.equal(matchesPath('module-a/src/file.ts', 'module-a'), true);
  assert.equal(matchesPath('module-alpha/src/file.ts', 'module-a'), false);
});

test('directory overlap allows traversal toward included children', () => {
  assert.equal(overlapsDirectory('src', 'src/features'), true);
  assert.equal(overlapsDirectory('src/features', 'src'), true);
  assert.equal(overlapsDirectory('scripts', 'src/features'), false);
});

test('filters use explicit type and patterns match filename only', () => {
  const rules = [
    { type: 'PATH' as const, action: 'INCLUDE' as const, value: 'src', enabled: true },
    { type: 'PATTERN' as const, action: 'EXCLUDE' as const, value: '*.test.ts', enabled: true }
  ];

  assert.equal(fileMatchesFilters('src/main.ts', rules, true, true), true);
  assert.equal(fileMatchesFilters('src/main.test.ts', rules, true, true), false);
  assert.equal(fileMatchesFilters('docs/main.ts', rules, true, true), false);
});

test('absolute path rules match against the absolute path when provided', () => {
  const absolute = '/tmp/project/src/secret.ts';
  assert.equal(
    fileMatchesFilters('src/secret.ts', [
      { type: 'PATH', action: 'EXCLUDE', value: absolute, enabled: true }
    ], true, true, absolute),
    false
  );
});

test('PATTERN alternation is anchored as a whole, like IntelliJ String.matches', () => {
  // `^foo|bar$` parses as `(^foo)|(bar$)`, so without the (?:) group `foobaz` and
  // `bazbar` matched here but not in ClipCode. Both tools must agree on the file set.
  const rules = [{ enabled: true, action: 'EXCLUDE' as const, type: 'PATTERN' as const, value: 'foo|bar' }];
  assert.equal(fileMatchesFilters('foo', rules, false, true), false, 'exact left alternative is excluded');
  assert.equal(fileMatchesFilters('bar', rules, false, true), false, 'exact right alternative is excluded');
  assert.equal(fileMatchesFilters('foobaz', rules, false, true), true, 'prefix match must NOT be excluded');
  assert.equal(fileMatchesFilters('bazbar', rules, false, true), true, 'suffix match must NOT be excluded');
});

test('a file outside every root has no relative identity, so relative PATH rules skip it', () => {
  // Every copy surface passes toClipboardPathFromRoots's result as the relative path, and
  // for a file under no workspace root that result IS the absolute path. normalizePath
  // strips the leading '/', so `/repo/secret.txt` used to satisfy the relative rule
  // `repo/secret.txt` by pure coincidence. IntelliJ never could — relativeFilterPath
  // returns null for an absolute path — so the two tools gave different answers for the
  // same rule and the same file.
  const outside = '/repo/secret.txt';
  const relativeRule = [{ type: 'PATH' as const, action: 'INCLUDE' as const, value: 'repo/secret.txt', enabled: true }];
  // INCLUDE: nothing matches -> not copied (Kotlin: includeRules.none{} -> false).
  assert.equal(fileMatchesFilters(outside, relativeRule, true, false, outside), false);

  // EXCLUDE: the rule cannot claim it either, so the file is NOT excluded by it.
  const excludeRule = [{ type: 'PATH' as const, action: 'EXCLUDE' as const, value: 'repo/secret.txt', enabled: true }];
  assert.equal(fileMatchesFilters(outside, excludeRule, false, true, outside), true);

  // An ABSOLUTE rule still matches it — that is the spelling that genuinely names the file.
  const absoluteRule = [{ type: 'PATH' as const, action: 'EXCLUDE' as const, value: outside, enabled: true }];
  assert.equal(fileMatchesFilters(outside, absoluteRule, false, true, outside), false);

  // An ordinary in-workspace path is untouched.
  assert.equal(fileMatchesFilters('repo/secret.txt', relativeRule, true, false, '/ws/repo/secret.txt'), true);
});
