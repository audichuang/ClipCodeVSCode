/* SNIPCODE-HOOK start: live-QA-1 theme-selector invariants, read from source.
 *
 * happy-dom computes no cascade, so no component test can catch "the HC-dark
 * rule wins over the light rule in HC Light" — the exact defect a real-VS Code
 * pass found on the graph's branch badges (white text on a white badge). These
 * two invariants are therefore pinned against the stylesheet text itself.
 *
 * The premise, verified against the real product (VS Code 1.128.0,
 * out/vs/workbench/contrib/webview/browser/pre/index.html): on a theme change
 * the host clears all four theme classes and adds the active one, and for HC
 * Light it adds `vscode-high-contrast` as well, for backwards compatibility.
 * So in HC Light the body carries BOTH high-contrast classes and NOT
 * `vscode-light` — which is why a light rule must name HC Light explicitly, and
 * why an HC-dark rule must exclude it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WEBVIEW_SRC = join(__dirname, '..', '..', 'webview-ui', 'src');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) { return e.name === '__tests__' ? [] : svelteFiles(p); }
    return e.name.endsWith('.svelte') ? [p] : [];
  });
}

/** Every individual selector in the file's <style> blocks (rule lists split on
 *  `,`), comments stripped and whitespace normalised — a companion may live in
 *  the same selector list OR as its own duplicated rule, and both are fine. */
function selectorLists(source: string): string[] {
  const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  return styles.flatMap(css =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]*)\{/g)]
      .map(m => m[1].replace(/\s+/g, ' ').trim())
      .filter(sel => sel.length > 0 && !sel.startsWith('@')),
  );
}

/** …and the individual selectors inside them. */
function selectors(source: string): string[] {
  return selectorLists(source)
    .flatMap(list => list.split(','))
    .map(sel => sel.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const FILES = svelteFiles(WEBVIEW_SRC);

describe('theme selector invariants (webview stylesheets)', () => {
  it('finds the component stylesheets it is meant to guard', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('every `body.vscode-light` selector has an HC Light twin — it is a light background too', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const all = new Set(selectors(readFileSync(file, 'utf8')));
      for (const sel of all) {
        if (!sel.includes('body.vscode-light')) { continue; }
        const twin = sel.replace('body.vscode-light', 'body.vscode-high-contrast-light');
        if (!all.has(twin)) { offenders.push(`${file.slice(WEBVIEW_SRC.length + 1)}: ${sel}`); }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no `body.vscode-high-contrast` rule silently claims HC Light as well', () => {
    // Either it excludes HC Light (`:not(.vscode-high-contrast-light)`) or it
    // names it deliberately — what it must never do is ignore it, because the
    // host puts the HC-dark class on the body in HC Light too.
    const offenders: string[] = [];
    for (const file of FILES) {
      // Rule level, not selector level: naming both variants in ONE list (as the
      // bolder graph rail does) is a legitimate way to cover HC Light.
      for (const sel of selectorLists(readFileSync(file, 'utf8'))) {
        if (/vscode-high-contrast(?![-\w])/.test(sel) && !sel.includes('vscode-high-contrast-light')) {
          offenders.push(`${file.slice(WEBVIEW_SRC.length + 1)}: ${sel}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
/* SNIPCODE-HOOK end */
