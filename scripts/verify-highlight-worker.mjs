// Run after build:graph-webview. Compare the actual bundled worker with the local helpers.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const req = createRequire(join(root, 'graph/webview-ui/package.json'));
const scratch = await mkdtemp(join(tmpdir(), 'snipcode-worker-parity-'));
let worker;
try {
  const helpers = join(scratch, 'helpers.cjs');
  await build({
    entryPoints: [join(root, 'graph/webview-ui/src/lib/utils/highlighter.ts')],
    outfile: helpers, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'installed-shiki', setup(b) {
      b.onResolve({ filter: /^shiki(?:\/|$)/ }, args => ({ path: req.resolve(args.path), external: true }));
    } }],
  });
  const local = createRequire(import.meta.url)(helpers);
  const h = await local.getHighlighter();
  worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    globalThis.postMessage=m=>parentPort.postMessage(m);
    parentPort.on('message',m=>globalThis.onmessage({data:m}));
    import(workerData).then(()=>parentPort.postMessage({id:0}));
  `, { eval: true, workerData: pathToFileURL(join(root, 'dist/graph-webview/highlight-worker.js')).href });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  let sequence = 0;
  async function send(payload) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const fail = e => { clearTimeout(timer); worker.off('message', done); reject(e); };
      const done = reply => {
        if (reply.id !== id) return;
        clearTimeout(timer); worker.off('message', done); worker.off('error', fail);
        reply.error ? reject(new Error(reply.error)) : resolve(reply);
      };
      const timer = setTimeout(() => fail(new Error('worker reply timed out')), 10000);
      worker.on('message', done); worker.once('error', fail); worker.postMessage({ ...payload, id });
    });
  }
  const examples = {
    typescript: 'const value = "<&😄>";', java: 'String value = "<&😄>";',
    json: '{"value": "<&😄>"}', sql: "SELECT value FROM records WHERE id = 2;",
    markdown: '# Title with **bold** and <&😄>',
  };
  let cases = 0;
  for (const [lang, content] of Object.entries(examples)) {
    await local.ensureLanguage(h, lang);
    await send({ type: 'warm', lang });
    for (const theme of ['dark-plus', 'light-plus']) {
      const lines = Array.from({ length: 64 }, (_, i) => ({ content,
        ...(i % 2 ? { ranges: [{ start: 4, end: 16 }], kind: 'add' } : {}),
      }));
      const { html } = await send({ type: 'highlight', lang, theme, lines });
      const expected = lines.map(l => l.ranges
        ? local.highlightLineWithRanges(h, l.content, lang, l.ranges, l.kind, theme)
        : local.highlightLineSync(h, l.content, lang, theme));
      assert.deepEqual(html, expected, `${lang}/${theme}`);
      cases++;
    }
  }
  h.dispose();
  console.log(`Bundled worker parity: ${cases} cases passed (5 languages, 2 themes, Unicode + word ranges).`);
} finally {
  await worker?.terminate();
  await rm(scratch, { recursive: true, force: true });
}
