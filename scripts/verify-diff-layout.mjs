// Run after build:graph-webview. Real Chromium layout, not happy-dom.
// CHROME_BIN overrides the local Chrome/Chromium executable. No browser download.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPerformance } from './diff-performance-check.mjs';

async function checkLayout() {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const emit = data => window.dispatchEvent(new MessageEvent('message', { data }));
  try {
    await window.diffReady;
    const hunk = (start, entries) => {
      let old = start, next = start;
      const lines = entries.map(([type, content]) => ({ type, content,
        ...(type !== 'add' ? { oldLineNumber: old++ } : {}),
        ...(type !== 'delete' ? { newLineNumber: next++ } : {}) }));
      return { header: '@@ layout fixture @@', oldStart: start, newStart: start,
        oldLines: old - start, newLines: next - start, lines };
    };
    const diff = { file: 'layout.sql', isBinary: false, isImage: false, hunks: [
      hunk(1, [['context', ''], ['delete', 'select OLD_NAME;'], ['add', 'select NEW_NAME;'],
        ['context', 'select 1;'], ['add', 'select 2;'], ['add', 'select 3;'], ['context', 'select 4;']]),
      hunk(20, [['context', 'select 1;'], ['delete', 'select 2;'], ['delete', 'select 3;'],
        ['delete', 'select 4;'], ['context', ''], ['add', 'select 5;'], ['context', 'select 6;']]),
      hunk(40, [['context', 'select ' + 'wide_column, '.repeat(80) + '1;'],
        ['delete', 'select 1;'], ['delete', 'select 2;'], ['add', 'select 3;'],
        ['add', 'select 4;'], ['add', 'select 5;'], ['add', 'select 6;'], ['add', 'select 7;'], ['context', '']]),
    ] };
    emit({ type: 'setLocale', payload: { locale: 'zh-tw' } });
    emit({ type: 'diffShow', payload: { repoPath: '/layout-test', file: diff.file,
      generation: 1, stagedDiff: diff, unstagedDiff: diff } });
    for (let i = 0; i < 180 && document.querySelectorAll('.sbs-center-cell').length !== 40; i++) await frame();
    check(document.querySelectorAll('.sbs-center-cell').length === 40, 'Fixture did not fully render (expected 40 aligned rows)');
    const results = [];
    for (const width of [1200, 430]) for (const font of [12, 14, 20, 24]) {
      document.querySelector('.diff-app-root').style.width = width + 'px';
      document.body.style.setProperty('--vscode-editor-font-size', font + 'px');
      await frame(); await frame();
      const columns = ['.sbs-left .diff-line', '.sbs-center-cell', '.sbs-right .diff-line']
        .map(selector => [...document.querySelectorAll(selector)]);
      check(columns.every(c => c.length === 40), 'Missing rows in a column');
      check(parseFloat(getComputedStyle(columns[0][0]).fontSize) === font, 'Editor font setting did not reach the rendered rows');
      let maxDelta = 0;
      for (let i = 0; i < 40; i++) {
        const boxes = columns.map(c => c[i].getBoundingClientRect());
        for (const key of ['y', 'height']) {
          const values = boxes.map(b => b[key]);
          maxDelta = Math.max(maxDelta, Math.max(...values) - Math.min(...values));
        }
        const [left, center, right] = columns.map(c => c[i]);
        if (left.classList.contains('diff-context') && right.classList.contains('diff-context')) {
          check(!/cell-(add|delete|modify)/.test(center.className), 'Unchanged context is marked as changed');
        }
      }
      check(maxDelta < 0.5, `Three-column misalignment at ${font}px / ${width}px: ${maxDelta}px`);
      results.push({ width, font, rows: 40, maxDelta });
    }
    check(document.querySelector('.staged-btn')?.getAttribute('aria-label') === '取消暫存此變更塊', 'Chinese staged action lost its semantic class/label');
    const button = document.querySelector('.sbs-block-stage-btn');
    const hit = getComputedStyle(button, '::after');
    check(parseFloat(hit.width) >= 28 && parseFloat(hit.height) >= 28, 'Expanded center hit area missing');
    const box = button.getBoundingClientRect();
    check(document.elementFromPoint(box.left - 2, box.y + box.height / 2)?.closest('button') === button,
      'Transparent area outside the visible button does not receive clicks');
    const section = document.querySelector('.diff-sbs');
    const left = section.querySelector('.sbs-left'), right = section.querySelector('.sbs-right');
    const center = section.querySelector('.sbs-center-gutter');
    const centerX = center.getBoundingClientRect().x;
    left.scrollLeft = 120;
    for (let i = 0; i < 30 && Math.abs(right.scrollLeft - left.scrollLeft) > 1; i++) await frame();
    check(left.scrollLeft > 0 && Math.abs(right.scrollLeft - left.scrollLeft) < 1, 'Horizontal scroll is not synchronized');
    check(Math.abs(center.getBoundingClientRect().x - centerX) < 0.5, 'Center gutter moved with horizontal scroll');
    await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: true, results }) });
  } catch (error) {
    await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: false, error: String(error.stack || error) }) });
  }
}

const assets = fileURLToPath(new URL('../dist/graph-webview/', import.meta.url));
const performanceMode = process.argv.includes('--performance');
const budgets = performanceMode ? JSON.parse(await readFile(new URL('./diff-performance-budgets.json', import.meta.url), 'utf8')) : null;
const reportDir = fileURLToPath(new URL('../test-results/', import.meta.url));
const reportPath = join(reportDir, performanceMode ? 'diff-performance.json' : 'diff-layout.json');
await mkdir(reportDir, { recursive: true });
const metadata = { startedAt: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  assets: Object.fromEntries(await Promise.all(['diff.js', 'diff.css'].map(async name =>
    [name, createHash('sha256').update(await readFile(join(assets, name))).digest('hex')]))), };
await writeFile(reportPath, JSON.stringify({ ...metadata, status: 'running' }, null, 2));
await access(join(assets, 'diff.js'));
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const profile = await mkdtemp(join(tmpdir(), 'snipcode-layout-'));
let complete, browser, timer, stderr = '';
const result = new Promise(resolve => { complete = resolve; });
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/diff.css"><link rel="stylesheet" href="/codicon.css"></head>
<body class="vscode-dark" style="--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px"><div id="diff-app"></div>
<script>window.onerror=(message,source,line,column)=>fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:String(message)+' at '+source+':'+line+':'+column})});window.onunhandledrejection=e=>window.onerror(e.reason);window.diffReady=new Promise(r=>window.ready=r);window.acquireVsCodeApi=()=>({getState:()=>({diffMode:'side-by-side'}),setState:()=>{},postMessage:m=>{if(m.type==='diffReady')ready()}});</script>
<script src="/diff.js"></script><script>(${(performanceMode ? checkPerformance : checkLayout).toString()})(${JSON.stringify(budgets)})</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/result' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    try { complete(JSON.parse(body)); } catch { complete({ ok: false, error: 'Invalid browser result' }); }
    res.end('ok'); return;
  }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  const path = resolve(assets, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(assets.endsWith(sep) ? assets : assets + sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
  browser.once('error', error => complete({ ok: false, error: `Cannot start ${chrome}: ${error.message}` }));
  browser.once('exit', code => complete({ ok: false, error: `Browser exited before checks completed (${code})` }));
  timer = setTimeout(() => complete({ ok: false, error: 'Browser checks timed out' }), performanceMode ? 120000 : 30000);
  const outcome = await result;
  await writeFile(reportPath, JSON.stringify({ ...metadata, status: outcome.ok ? 'passed' : 'failed', ...outcome }, null, 2));
  if (!outcome.ok) throw Error(outcome.error + '\n' + stderr);
  console.log(`Diff browser ${performanceMode ? 'performance' : 'layout'} checks passed:`, JSON.stringify(outcome.summary || outcome.results));
  console.log('Report:', reportPath);
} finally {
  clearTimeout(timer);
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    const forceStop = setTimeout(() => browser.kill('SIGKILL'), 5000);
    browser.kill(); await exited; clearTimeout(forceStop);
  }
  server.closeAllConnections(); server.close();
  await rm(profile, { recursive: true, force: true });
}
