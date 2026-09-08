/* SNIPCODE-HOOK: optional background highlighting; the first screen never waits for it. */
import type { Range } from './word-diff';

export interface HighlightWorkLine { content: string; ranges?: Range[]; kind?: 'add' | 'delete' }
export type HighlightTheme = 'dark-plus' | 'light-plus';
interface Reply { id: number; html?: string[]; error?: string }
let worker: Worker | undefined;
let starting: Promise<Worker> | undefined;
let disabled = false;
let blobUrl: string | undefined;
let sequence = 0;
const warmed = new Set<string>();
const warming = new Set<string>();
const pending = new Map<number, { finish: (reply?: Reply) => void }>();

function stop(): void {
  disabled = true;
  worker?.terminate();
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined; }
  worker = undefined;
  warmed.clear();
  for (const entry of pending.values()) entry.finish();
  pending.clear();
}

function getWorker(): Promise<Worker> | undefined {
  if (disabled || typeof Worker === 'undefined' || typeof document === 'undefined') return;
  const uri = document.body.dataset.highlightWorker;
  if (!uri) return;
  return starting ??= (async () => {
    const response = await fetch(uri, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Highlight worker could not load');
    blobUrl = URL.createObjectURL(await response.blob());
    const w = new Worker(blobUrl);
    worker = w;
    w.addEventListener('message', (event: MessageEvent<Reply>) => pending.get(event.data?.id)?.finish(event.data));
    w.addEventListener('error', stop);
    w.addEventListener('messageerror', stop);
    window.addEventListener('pagehide', stop, { once: true });
    // The script has loaded when its first reply arrives; release the source blob.
    w.addEventListener('message', () => { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = undefined; }, { once: true });
    return w;
  })().catch(() => { stop(); throw new Error('Background highlighting unavailable'); });
}

function request(w: Worker, payload: object, signal?: AbortSignal): Promise<Reply | undefined> {
  if (signal?.aborted || disabled) return Promise.resolve(undefined);
  const id = ++sequence;
  return new Promise(resolve => {
    const abort = () => { try { w.postMessage({ type: 'cancel', id }); } catch { /* worker already stopped */ }
      finish(); };
    const timer = setTimeout(() => { stop(); }, 5000);
    const finish = (reply?: Reply) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      pending.delete(id);
      resolve(reply);
    };
    pending.set(id, { finish });
    signal?.addEventListener('abort', abort, { once: true });
    try { w.postMessage({ ...payload, id }); } catch { stop(); }
  });
}

export function warmHighlightWorker(lang: string): void {
  if (!lang || warmed.has(lang) || warming.has(lang)) return;
  const init = getWorker();
  if (!init) return;
  warming.add(lang);
  void init.then(w => request(w, { type: 'warm', lang })).then(reply => {
    if (reply?.error) stop();
    else if (reply && !disabled) warmed.add(lang);
  }).catch(() => {}).finally(() => warming.delete(lang));
}

export async function highlightWorkerBatch(lines: HighlightWorkLine[], lang: string, theme: HighlightTheme, signal: AbortSignal): Promise<string[] | undefined> {
  // Small/cached edits and worker startup keep the low-latency local path.
  if (!worker || !warmed.has(lang) || lines.length < 16 || signal.aborted || disabled) return;
  const reply = await request(worker, { type: 'highlight', lines, lang, theme }, signal);
  if (reply?.error || !Array.isArray(reply?.html) || reply.html.length !== lines.length || !reply.html.every(x => typeof x === 'string')) return;
  return reply.html;
}
