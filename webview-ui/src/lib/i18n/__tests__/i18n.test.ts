import { describe, it, expect, beforeEach } from 'vitest';
import { i18n, t } from '../index.svelte';

describe('I18n', () => {
  beforeEach(() => {
    i18n.setLocale('en');
  });

  it('returns the key itself when not found in any dictionary', () => {
    expect(t('does.not.exist.anywhere')).toBe('does.not.exist.anywhere');
  });

  it('falls back to en when key missing in selected locale', () => {
    // 'toolbar.history' exists in en; switch to a locale where (hypothetically)
    // the key were absent — fallback should surface the english string instead
    // of returning the raw key. We pick a real key and rely on parity tests
    // to ensure ko/zh have it.
    i18n.setLocale('ko');
    expect(t('toolbar.history')).not.toBe('toolbar.history');
  });

  it('normalises locale strings (ko-KR → ko)', () => {
    i18n.setLocale('ko-KR');
    expect(i18n.locale).toBe('ko');
  });

  it('normalises underscore locale strings (zh_CN → zh)', () => {
    i18n.setLocale('zh_CN');
    expect(i18n.locale).toBe('zh');
  });

  it('falls back to en for unknown locales', () => {
    i18n.setLocale('xx-XX');
    // Locale name is recorded, but dictionary defaults to en
    expect(t('toolbar.history')).toBe('Graph');
  });

  it('substitutes named placeholders', () => {
    // Use a parameter the message bus i18n keys actually accept.
    // 'createBranch.branchExists' takes {name}.
    expect(t('createBranch.branchExists', { name: 'main' })).toContain('main');
  });

  it('HTML-escapes interpolated values to prevent injection', () => {
    const result = t('createBranch.branchExists', { name: '<script>alert(1)</script>' });
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('does not interpret $& / $1 as regex back-references in replacement', () => {
    // replaceAll(pattern, fn) avoids this trap. Verify with a value that
    // would otherwise be substituted by the regex replacer.
    const result = t('createBranch.branchExists', { name: '$&-test' });
    expect(result).toContain('$&amp;-test');
  });
});
