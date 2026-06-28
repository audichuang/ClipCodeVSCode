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
