import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  sent: Array<{ id: number; type: string }> = [];
  terminate = vi.fn();
  constructor(_url: string) { super(); TestWorker.instances.push(this); }
  postMessage(data: { id: number; type: string }) { this.sent.push(data); }
  reply(data: object) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
beforeEach(() => {
  vi.resetModules(); TestWorker.instances = [];
  document.body.dataset.highlightWorker = 'https://assets.test/worker.js';
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['worker']) })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-worker');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  delete document.body.dataset.highlightWorker;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function warm() {
  const client = await import('../highlight-worker-client');
  client.warmHighlightWorker('typescript');
  await waitFor(() => expect(TestWorker.instances[0]?.sent).toHaveLength(1));
  const worker = TestWorker.instances[0];
  worker.reply({ id: worker.sent[0].id });
  await Promise.resolve();
  return { client, worker };
}
const lines = Array.from({ length: 64 }, () => ({ content: 'const n = 1;' }));
describe('optional background highlighting', () => {
  it('keeps startup and small batches on the local path', async () => {
    const client = await import('../highlight-worker-client');
    const signal = new AbortController().signal;
    client.warmHighlightWorker('typescript');
    expect(await client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', signal)).toBeUndefined();
    const { worker } = await warm();
    expect(await client.highlightWorkerBatch(lines.slice(0, 10), 'typescript', 'dark-plus', signal)).toBeUndefined();
    expect(worker.sent).toHaveLength(1);
  });
  it('correlates batches and ignores a late cancelled response', async () => {
    const { client, worker } = await warm();
    const abort = new AbortController();
    const old = client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', abort.signal);
    const oldId = worker.sent.at(-1)!.id;
    abort.abort(); expect(await old).toBeUndefined();
    expect(worker.sent.at(-1)!.type).toBe('cancel');
    const next = client.highlightWorkerBatch(lines, 'typescript', 'light-plus', new AbortController().signal);
    worker.reply({ id: oldId, html: lines.map(() => 'stale') });
    worker.reply({ id: worker.sent.at(-1)!.id, html: lines.map(() => 'fresh') });
    expect(await next).toEqual(lines.map(() => 'fresh'));
  });
  it('falls back after failure without restarting for every batch', async () => {
    const { client, worker } = await warm();
    const pending = client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', new AbortController().signal);
    worker.dispatchEvent(new Event('error'));
    expect(await pending).toBeUndefined();
    client.warmHighlightWorker('typescript');
    expect(await client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', new AbortController().signal)).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(TestWorker.instances).toHaveLength(1);
  });
  it('times out a vanished reply', async () => {
    const { client, worker } = await warm();
    vi.useFakeTimers();
    const result = client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBeUndefined(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('needs no worker when the host provides no resource', async () => {
    delete document.body.dataset.highlightWorker;
    const client = await import('../highlight-worker-client');
    client.warmHighlightWorker('typescript');
    expect(fetch).not.toHaveBeenCalled();
    expect(await client.highlightWorkerBatch(lines, 'typescript', 'dark-plus', new AbortController().signal)).toBeUndefined();
  });
});
