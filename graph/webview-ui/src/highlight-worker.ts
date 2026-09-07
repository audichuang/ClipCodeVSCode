/* SNIPCODE-HOOK: self-contained worker; no runtime module or grammar fetches. */
import { getHighlighter, ensureLanguage, warmLanguage, highlightLineSync, highlightLineWithRanges } from './lib/utils/highlighter';
import type { HighlightTheme, HighlightWorkLine } from './lib/utils/highlight-worker-client';
interface Request { id: number; type: 'warm' | 'highlight' | 'cancel'; lang: string; theme: HighlightTheme; lines?: HighlightWorkLine[] }
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (message: { id: number; html?: string[]; error?: string }) => void;
};
const active = new Set<number>();
const cancelled = new Set<number>();
scope.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { if (active.has(data.id)) cancelled.add(data.id); return; }
  active.add(data.id);
  try {
    const h = await getHighlighter();
    if (!await ensureLanguage(h, data.lang)) throw new Error('Grammar unavailable');
    if (cancelled.has(data.id)) return;
    if (data.type === 'warm') {
      await warmLanguage(data.lang);
      if (!cancelled.has(data.id)) scope.postMessage({ id: data.id });
      return;
    }
    if (!Array.isArray(data.lines) || data.lines.length > 200) throw new Error('Invalid highlight batch');
    const html = data.lines.map(line => line.ranges && line.kind
      ? highlightLineWithRanges(h, line.content, data.lang, line.ranges, line.kind, data.theme)
      : highlightLineSync(h, line.content, data.lang, data.theme));
    scope.postMessage({ id: data.id, html });
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    active.delete(data.id);
    cancelled.delete(data.id);
  }
};
