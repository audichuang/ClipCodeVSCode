import { en } from './en';
import { ko } from './ko';
import { zh } from './zh';
/* SNIPCODE-HOOK start: X1-2 zh-tw dictionary (was silently falling back to zh-cn) */
import { zhTw } from './zh-tw';
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: X1-2 zh-tw dictionary (was silently falling back to zh-cn) */
const dictionaries: Record<string, Record<string, string>> = { en, ko, zh, 'zh-tw': zhTw };

/** Fold Chinese script/region variants VS Code can hand us (`vscode.env.language`,
 *  or a manually-picked `gitGraphPlus.locale`) onto the canonical dictionary key
 *  `zh-tw` — `zh-Hant*` (Traditional script, any region) and `zh-HK` (Hong Kong,
 *  which uses Traditional characters) both mean "give them zh-tw", not the plain
 *  `zh` (simplified) fallback further down. Plain `zh-CN` stays unmapped so it
 *  falls through to the `zh` simplified dictionary below. */
function normalizeFullLocale(full: string): string {
  if (/^zh-hant(-|$)/.test(full) || full === 'zh-hk' || full.startsWith('zh-hk-')) return 'zh-tw';
  return full;
}
/* SNIPCODE-HOOK end */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
}

class I18n {
  locale = $state('en');
  private dict = $state<Record<string, string>>(en);

  setLocale(loc: string) {
    /* SNIPCODE-HOOK start: X1-2 try the full locale (zh-tw vs zh-cn) before
       falling back to the bare language code — a zh-TW user was silently
       getting the zh-cn (simplified) dictionary via the old lang-only lookup. */
    const full = normalizeFullLocale(loc.toLowerCase().replace(/_/g, '-'));
    const lang = full.split('-')[0];
    const matchedKey = full in dictionaries ? full : lang;
    this.locale = matchedKey;
    this.dict = dictionaries[full] ?? dictionaries[lang] ?? en;
    /* SNIPCODE-HOOK end */
  }

  t(key: string, params?: Record<string, string | number>): string {
    let str = this.dict[key] ?? en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        const replacement = escapeHtml(String(v));
        // Use a function replacer so `$&`, `$1`, etc. in replacement are not
        // interpreted as special replacement patterns by replaceAll.
        str = str.replaceAll(`{${k}}`, () => replacement);
      }
    }
    return str;
  }
}

export const i18n = new I18n();

export function t(key: string, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}
