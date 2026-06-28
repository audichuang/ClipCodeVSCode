import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, normalizeSettings } from '../src/settings.js';

test('defaults match IntelliJ ClipCode settings', () => {
  assert.equal(defaultSettings.headerFormat, '// file: $FILE_PATH');
  assert.equal(defaultSettings.fileCountLimit, 30);
  assert.equal(defaultSettings.maxFileSizeKB, 500);
  assert.equal(defaultSettings.addExtraLineBetweenFiles, true);
});

test('filter rule type is preserved explicitly', () => {
  const settings = normalizeSettings({
    filterRules: [{ type: 'PATH', action: 'EXCLUDE', value: '.github', enabled: true }]
  });
  assert.deepEqual(settings.filterRules[0], {
    type: 'PATH',
    action: 'EXCLUDE',
    value: '.github',
    enabled: true
  });
});
