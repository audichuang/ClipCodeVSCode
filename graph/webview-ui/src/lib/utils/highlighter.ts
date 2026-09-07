import type { HighlighterCore, ThemedToken, LanguageRegistration } from 'shiki';
import type { Range } from './word-diff';

let highlighter: HighlighterCore | null = null;
let loadingPromise: Promise<HighlighterCore> | null = null;
/* SNIPCODE-HOOK start: perf — bounded engine-startup retry */
let warnedEngineFailure = false;
let engineFailures = 0;
/** Transient failures get a couple of retries; permanent ones must not. */
const MAX_ENGINE_ATTEMPTS = 2;
/* SNIPCODE-HOOK end */

const LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  json: 'json', html: 'html', css: 'css', scss: 'scss',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  yaml: 'yaml', yml: 'yaml', md: 'markdown', mdx: 'mdx',
  sql: 'sql', xml: 'xml', svg: 'xml',
  toml: 'toml', ini: 'ini', dockerfile: 'dockerfile',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  cs: 'csharp', fs: 'fsharp',
  graphql: 'graphql', gql: 'graphql',
  txt: '', '': '',
};

// One dynamic import per Shiki grammar. Languages are pulled in on demand the
// first time a diff needs them (see ensureLanguage) instead of being bundled
// into the highlighter at init — keeps first-open light while still covering
// every language LANG_MAP can resolve to. Every value here must have a matching
// LANG_MAP entry, otherwise the grammar can never be requested.
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  make: () => import('shiki/langs/make.mjs'),
};

export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const base = filename.split('/').pop()?.toLowerCase() ?? '';

  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'make';

  return LANG_MAP[ext] ?? '';
}

export async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { createHighlighterCore } = await import('shiki');
    /* SNIPCODE-HOOK start: perf — oniguruma WASM instead of the pure-JS regex
       engine. Measured on this repo's own git-service.ts with the real per-line
       call path: 50 rendered lines 340ms -> 94ms, 3000 lines 1315ms -> 537ms.
       Engine construction goes 3ms -> 29ms, paid once per webview and dwarfed
       by the first file's tokenising either way.

       `shiki/wasm` re-exports @shikijs/engine-oniguruma/wasm-inlined, so the
       466KB binary is embedded in the bundle: no runtime fetch, and therefore
       no `connect-src` relaxation. Compiling it DOES need `wasm-unsafe-eval`
       in the host CSP — added in MainPanel and DiffPanel only, the two panels
       that load a shiki-carrying bundle (workbench.js has no shiki at all, so
       the commit box and the recent-commits sidebar stay strict). Without that
       directive `createOnigurumaEngine` rejects and getHighlighter() throws,
       which the callers already treat as "render unhighlighted". */
    const { createOnigurumaEngine } = await import('shiki/engine/oniguruma');

    const engine = await createOnigurumaEngine(import('shiki/wasm'));
    /* SNIPCODE-HOOK end */

    // Both VS Code themes are loaded so we can match the editor's light/dark
    // appearance (see activeShikiTheme). Grammars start empty and load lazily.
    const h = await createHighlighterCore({
      themes: [
        import('shiki/themes/dark-plus.mjs'),
        import('shiki/themes/light-plus.mjs'),
      ],
      langs: [],
      engine,
    });

    highlighter = h;
    return h;
  })()
    /* SNIPCODE-HOOK start: perf — engine startup can fail now that it compiles
       WebAssembly, and the two obvious handling choices are both wrong:

       - Caching the rejection in `loadingPromise` forever means ONE failure
         disables highlighting for the life of the webview, even when the cause
         was a transient first-load hiccup.
       - Clearing it unconditionally means a PERMANENT failure retries on every
         single diff open — one doomed WASM compile per click, forever.

       So the failure KIND decides. A host CSP without 'wasm-unsafe-eval'
       refuses compilation as a `WebAssembly.CompileError` (verified in headless
       Chrome: `CompileError: ... violates the following Content Security policy
       directive`), which is also the shape of corrupt wasm bytes — no retry can
       ever help either, so that rejection stays cached. Anything else gets a
       bounded retry and is then cached too.

       The warning is the only breadcrumb in any case: every caller treats a
       throw as "render this diff unhighlighted" and shows nothing. */
    .catch((error: unknown) => {
      engineFailures += 1;
      const permanent =
        typeof WebAssembly !== 'undefined' &&
        typeof WebAssembly.CompileError === 'function' &&
        error instanceof WebAssembly.CompileError;
      if (!permanent && engineFailures < MAX_ENGINE_ATTEMPTS) {
        loadingPromise = null; // let the next diff open try again
      }
      if (!warnedEngineFailure) {
        warnedEngineFailure = true;
        console.warn(
          `[snipcode] syntax highlighting is off — the Shiki engine failed to start${permanent ? ' (not retryable)' : ''}:`,
          error,
        );
      }
      throw error;
    });
    /* SNIPCODE-HOOK end */

  return loadingPromise;
}

// Dedupe concurrent loads of the same grammar so a multi-file diff session
// imports each language at most once.
const langLoadPromises = new Map<string, Promise<void>>();

/**
 * Ensure the grammar for `lang` is loaded into the highlighter. Returns true
 * once the language is available, false if it has no loader or the import
 * failed. Safe to call repeatedly — already-loaded languages resolve instantly.
 */
export async function ensureLanguage(h: HighlighterCore, lang: string): Promise<boolean> {
  if (!lang) return false;
  if (h.getLoadedLanguages().includes(lang as never)) return true;
  const loader = LANG_LOADERS[lang];
  if (!loader) return false;

  let p = langLoadPromises.get(lang);
  if (!p) {
    p = loader()
      .then(mod => {
        const grammar = (mod as { default: LanguageRegistration[] }).default;
        return h.loadLanguage(grammar);
      })
      .then(() => {});
    langLoadPromises.set(lang, p);
  }
  try {
    await p;
    return h.getLoadedLanguages().includes(lang as never);
  } catch {
    // Let a later call retry rather than caching the failure forever.
    langLoadPromises.delete(lang);
    return false;
  }
}

/* SNIPCODE-HOOK start: perf — warm a grammar before its first diff arrives.
   Loading a grammar is cheap (~2ms); what costs is oniguruma compiling that
   grammar's regexes LAZILY on the first scan — measured ~10ms for java and
   ~20ms for typescript, paid inside the first file's first highlight chunk,
   i.e. on the critical path to the first coloured frame. Tokenising one line
   that touches the common constructs (call, string, block, both comment kinds)
   compiles most of what a real first line then needs — a bare `x` left java
   8.4ms / typescript 17.3ms of compile on the first real lines, this line 2.2ms
   / 1.8ms (Node, oniguruma). Callers fire this
   when they learn the file name ahead of its diff (the Diff tab's
   `diffLoading` arrives before the host runs git). Fire-and-forget: every
   failure mode here is already handled by the real highlight pass. */
export async function warmLanguage(lang: string): Promise<void> {
  if (!lang) return;
  try {
    const h = await getHighlighter();
    if (!(await ensureLanguage(h, lang))) return;
    h.codeToTokens('a.b(c, "d") { /* e */ } // f', { lang: lang as never, theme: activeShikiTheme() });
  } catch {
    // The real pass reports/handles engine and grammar failures.
  }
}
/* SNIPCODE-HOOK end */

/** Theme that matches the current VS Code color theme, so highlighted tokens
 *  sit correctly on the diff background (dark-plus on dark, light-plus on light). */
export function activeShikiTheme(): 'dark-plus' | 'light-plus' {
  /* SNIPCODE-HOOK start: ui/diff D14 High Contrast Light is light, not dark */
  // VS Code puts `vscode-high-contrast-light` (NOT `vscode-light`) on body for
  // the HC-light theme; without this it fell through to dark-plus tokens on a
  // white background.
  const classes = typeof document !== 'undefined' ? document.body.classList : undefined;
  return classes?.contains('vscode-light') || classes?.contains('vscode-high-contrast-light')
    ? 'light-plus'
    : 'dark-plus';
  /* SNIPCODE-HOOK end */
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function highlightLineSync(
  h: HighlighterCore,
  content: string,
  lang: string,
  theme: 'dark-plus' | 'light-plus' = activeShikiTheme(),
): string {
  if (!lang) return escapeHtml(content);
  try {
    const loadedLangs = h.getLoadedLanguages();
    if (!loadedLangs.includes(lang as never)) return escapeHtml(content);

    const tokens = h.codeToTokens(content, { lang: lang as never, theme });
    if (!tokens.tokens[0]) return escapeHtml(content);

    return tokens.tokens[0]
      .map((token: ThemedToken) => {
        const color = token.color;
        const escaped = escapeHtml(token.content);
        return color ? `<span style="color:${color}">${escaped}</span>` : escaped;
      })
      .join('');
  } catch {
    return escapeHtml(content);
  }
}

export async function highlightLine(content: string, lang: string): Promise<string> {
  if (!lang) return escapeHtml(content);
  try {
    const h = await getHighlighter();
    await ensureLanguage(h, lang);
    return highlightLineSync(h, content, lang);
  } catch {
    return escapeHtml(content);
  }
}

/**
 * Like {@link highlightLineSync} but overlays a word-diff `background` class on
 * the given char ranges without disturbing Shiki's syntax colors. Splits each
 * colored token at range boundaries so an inner `word-diff-*` span wraps only the
 * changed characters. Falls back to a single uncolored token (plain text) when
 * the grammar is unavailable, so word-diff still shows without highlighting.
 */
export function highlightLineWithRanges(
  h: HighlighterCore,
  content: string,
  lang: string,
  ranges: Range[],
  kind: 'add' | 'delete',
  theme: 'dark-plus' | 'light-plus' = activeShikiTheme(),
): string {
  if (ranges.length === 0) { return highlightLineSync(h, content, lang, theme); }
  const cls = kind === 'add' ? 'word-diff-add' : 'word-diff-del';

  // Colored tokens as {text, color}; a single uncolored token when Shiki can't
  // tokenize (no grammar / error) so word-diff still works on plain text.
  let tokens: Array<{ text: string; color?: string }>;
  try {
    const loaded = !!lang && h.getLoadedLanguages().includes(lang as never);
    if (loaded) {
      const res = h.codeToTokens(content, { lang: lang as never, theme });
      tokens = (res.tokens[0] ?? []).map((tk) => ({ text: tk.content, color: tk.color }));
    } else {
      tokens = [{ text: content }];
    }
  } catch {
    tokens = [{ text: content }];
  }
  if (tokens.length === 0) { tokens = [{ text: content }]; }

  const inRange = (pos: number): boolean => ranges.some((r) => pos >= r.start && pos < r.end);

  let html = '';
  let offset = 0;
  for (const tk of tokens) {
    const open = tk.color ? `<span style="color:${tk.color}">` : '';
    const close = tk.color ? '</span>' : '';
    html += open;
    // Split the token into runs of same in/out-of-range, wrapping only the
    // changed runs so the surrounding syntax color is preserved. Step by whole
    // code point (not UTF-16 code unit): `ranges` offsets are UTF-16-based to
    // match Shiki's token indexing, but a surrogate pair (e.g. an emoji) must
    // never be torn into two spans on a lone half, which is invalid/mojibake
    // once rendered — classify the pair as a unit using its start offset.
    let run = '';
    let runInRange = tk.text.length > 0 ? inRange(offset) : false;
    let c = 0;
    while (c < tk.text.length) {
      const code = tk.text.charCodeAt(c);
      const nextCode = c + 1 < tk.text.length ? tk.text.charCodeAt(c + 1) : 0;
      const isSurrogatePair = code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff;
      const chunkLen = isSurrogatePair ? 2 : 1;
      const here = inRange(offset + c);
      if (here !== runInRange) {
        html += runInRange ? `<span class="${cls}">${escapeHtml(run)}</span>` : escapeHtml(run);
        run = '';
        runInRange = here;
      }
      run += tk.text.slice(c, c + chunkLen);
      c += chunkLen;
    }
    if (run) { html += runInRange ? `<span class="${cls}">${escapeHtml(run)}</span>` : escapeHtml(run); }
    html += close;
    offset += tk.text.length;
  }
  return html;
}

export { escapeHtml };
