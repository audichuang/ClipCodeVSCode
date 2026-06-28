import { describe, it, expect } from 'vitest';
import { en } from '../en';
import { ko } from '../ko';
import { zh } from '../zh';

// English is the source of truth: any key that ships in en.ts must have a
// translation in ko.ts and zh.ts (and vice versa — leftover keys in a
// translation usually mean an obsolete string that the en file already
// dropped). These checks catch drift the moment a contributor adds a string
// to one file but forgets the others.

const enKeys = new Set(Object.keys(en));
const koKeys = new Set(Object.keys(ko));
const zhKeys = new Set(Object.keys(zh));

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter(k => !b.has(k)).sort();
}

describe('i18n key parity', () => {
  it('ko has every key in en', () => {
    expect(diff(enKeys, koKeys)).toEqual([]);
  });

  it('zh has every key in en', () => {
    expect(diff(enKeys, zhKeys)).toEqual([]);
  });

  it('ko has no extra keys missing from en', () => {
    expect(diff(koKeys, enKeys)).toEqual([]);
  });

  it('zh has no extra keys missing from en', () => {
    expect(diff(zhKeys, enKeys)).toEqual([]);
  });

  it('every value is a non-empty string', () => {
    for (const [lang, dict] of [['en', en], ['ko', ko], ['zh', zh]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${lang}/${key} should be string`).toBe('string');
        expect(value.trim().length, `${lang}/${key} should not be blank`).toBeGreaterThan(0);
      }
    }
  });

  it('translations never introduce placeholders the caller does not provide', () => {
    // Translations are allowed to OMIT tokens that don't make grammatical
    // sense in the target language (e.g. zh has no plural so `{plural}` can
    // be dropped). They must NEVER add unknown tokens, since callers only
    // pass the param set the english string declares — an unmatched
    // `{foo}` would leak verbatim into the UI.
    const tokenRe = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g;
    for (const key of enKeys) {
      const enTokens = new Set(en[key].match(tokenRe) ?? []);
      for (const [lang, dict] of [['ko', ko], ['zh', zh]] as const) {
        const translated = dict[key];
        if (translated === undefined) continue;
        const otherTokens = translated.match(tokenRe) ?? [];
        for (const tok of otherTokens) {
          expect(enTokens, `${lang}/${key} introduces unknown placeholder ${tok}`)
            .toContain(tok);
        }
      }
    }
  });
});
