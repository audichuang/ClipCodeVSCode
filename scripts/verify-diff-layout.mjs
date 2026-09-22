// Run after build:graph-webview. Real Chromium layout, not happy-dom.
// CHROME_BIN overrides the browser. Otherwise a locally installed Chrome/Chromium/Edge is
// used, and when the machine has none, a PINNED chrome-headless-shell is fetched into
// <repo>/.cache/browsers: repo-local, gitignored, never installed system-wide and never
// --no-sandbox. A gate only this machine can run is the same class of bug as a test only
// this machine can run — but a browser that cannot be obtained is still a hard failure,
// never a silent skip.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPerformance } from './diff-performance-check.mjs';

// The build is PINNED, not resolved to whatever is stable today: the performance budgets
// are read against this binary, so letting it float would move the thing being measured
// under the thing measuring it. Bumping it is an intentional, reviewable edit, exactly
// like a budget edit — and it makes the gate MORE reproducible than the local Chrome it
// falls back from, which is whatever version that machine last updated to.
const HEADLESS_SHELL_BUILD = '154.0.8037.57';

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
// Written BEFORE the browser is resolved: resolving can fail (or download), and a throw must
// not leave the PREVIOUS run's 'passed' report as the newest file on disk.
await writeFile(reportPath, JSON.stringify({ ...metadata, status: 'running' }, null, 2));
await access(join(assets, 'diff.js'));
// CHROME_BIN wins; then the first browser actually installed; then the pinned headless shell.
// This used to be the bare name 'chromium' on every non-darwin platform, so a Linux box
// with Google Chrome but no `chromium` could not run this gate AT ALL — it died with
// "spawn chromium ENOENT" before any check, which reads as "gate skipped" rather than
// "gate missing". A machine-dependent gate is the same class of bug as a machine-dependent
// test. Absolute paths are probed directly; bare names go through which/where.
const localBrowser = process.env.CHROME_BIN ? undefined : findChrome();
const chrome = process.env.CHROME_BIN || localBrowser || await downloadHeadlessShell();
// Which binary produced these numbers is part of the record the budgets are read against.
// NOT `browser`: the performance check reports navigator.userAgent under that key and the
// outcome is spread over the metadata, so the path would be silently replaced in exactly
// the report that needs it — the two are complementary (which file ran, which build it is).
metadata.browserBinary = chrome;
await writeFile(reportPath, JSON.stringify({ ...metadata, status: 'running' }, null, 2));

function findChrome() {
  const { PROGRAMFILES, LOCALAPPDATA } = process.env;
  // Neither Chrome nor Edge adds itself to PATH on a stock Windows install, so probing
  // `where` alone finds NEITHER — the same "works on my machine" hole this function was
  // written to close on Linux, just moved one platform over. Probe the install dirs first.
  const winDirs = [PROGRAMFILES, process.env['ProgramFiles(x86)'], LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium', 'google-chrome', 'chromium']
    : process.platform === 'win32'
      ? [...winDirs.map(dir => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
         ...winDirs.map(dir => join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
         'chrome.exe', 'msedge.exe']
      : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const candidate of candidates) {
    // Either separator, plus a drive letter: not `sep`, so the branch for one platform stays
    // checkable by simulation from another — which is how this gap was found.
    if (/[\\/]/.test(candidate) || /^[A-Za-z]:/.test(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
  }
  // Nothing installed. Say so, rather than inventing a name that spawns into ENOENT —
  // the caller downloads the pinned shell instead.
  return null;
}

// `proxy-agent` and `yauzl` are devDependencies although nothing here imports them: they
// are OPTIONAL peers that @puppeteer/browsers loads dynamically, and each one silently
// removes a machine dependency when present. Without proxy-agent, HTTPS_PROXY / NO_PROXY
// are ignored and the download dies on any network that requires a proxy. Without yauzl,
// the .zip is extracted by shelling out to the system `unzip` (tar.exe / PowerShell on
// Windows), which minimal Linux images do not ship. A dependency audit will report both as
// unused — they are not; removing either reintroduces a failure on someone else's machine.
async function downloadHeadlessShell() {
  const cacheDir = fileURLToPath(new URL('../.cache/browsers/', import.meta.url));
  try {
    const { Browser, install, detectBrowserPlatform } = await import('@puppeteer/browsers');
    if (!detectBrowserPlatform()) throw Error(`unsupported platform ${platform()}/${arch()}`);
    // install() is idempotent: an already-downloaded build is returned without touching
    // the network, so only the first run on a machine pays for it.
    const installed = await install({ browser: Browser.CHROMEHEADLESSSHELL,
      buildId: HEADLESS_SHELL_BUILD, cacheDir });
    return installed.executablePath;
  } catch (error) {
    // A browser we cannot obtain fails the gate. It must never degrade into a skip.
    throw Error(`No local Chrome/Chromium/Edge, and chrome-headless-shell ${HEADLESS_SHELL_BUILD}`
      + ` could not be fetched into ${cacheDir}: ${error.message}\n`
      + 'Install Chrome, set CHROME_BIN, or make the download reachable.');
  }
}
// Resolves the CURRENT attempt; the server's /result handler calls it.
let complete;
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/diff.css"><link rel="stylesheet" href="/codicon.css"></head>
<body class="vscode-dark" data-highlight-worker="/highlight-worker.js" style="--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px"><div id="diff-app"></div>
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
// One launch of one browser against the running server. `early` marks an outcome that came
// from the browser dying or failing to start before posting any result — a fact about that
// browser on this machine, not about the webview under test.
async function attempt(browserPath) {
  const profile = await mkdtemp(join(tmpdir(), 'snipcode-layout-'));
  let browser, timer, stderr = '';
  const result = new Promise(resolve => { complete = resolve; });
  try {
    browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,900', `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
    browser.once('error', error => complete({ ok: false, early: true, error: `Cannot start ${browserPath}: ${error.message}` }));
    browser.once('exit', code => complete({ ok: false, early: true, error: `Browser exited before checks completed (${code})` }));
    timer = setTimeout(() => complete({ ok: false, error: 'Browser checks timed out' }), performanceMode ? 120000 : 30000);
    return { outcome: await result, stderr };
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      const forceStop = setTimeout(() => browser.kill('SIGKILL'), 5000);
      browser.kill(); await exited; clearTimeout(forceStop);
    }
    // Chrome's children can still be flushing into the profile when we unlink it, so a bare
    // rm -rf races and throws ENOTEMPTY — node retries exactly these errno's for us. And this
    // runs in `finally`: a throw here REPLACES the real outcome, so a genuine budget failure
    // would be reported as a temp-dir error, and a clean pass would exit 1. Cleanup must never
    // decide the exit code.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(error => console.warn(`warning: could not remove ${profile}: ${error.message}`));
  }
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let { outcome, stderr } = await attempt(chrome);
  // A browser this machine happens to have installed that cannot even START headless (seen:
  // a Homebrew-cask Google Chrome dying with `FATAL … Failed to get the path for 1001` before
  // loading the page) says nothing about the webview — but it turned the gate red on every
  // run the moment Chrome was installed. Fall back to the pinned shell, loudly. Never for
  // CHROME_BIN (an explicit choice fails as chosen), never for the shell itself, and never
  // on a timeout, which can be the webview hanging — a real signal.
  if (outcome.early && chrome === localBrowser) {
    // The exit can arrive before the last stderr chunk, so the tail may be empty.
    const lastLines = stderr.trim() ? `\n  ${stderr.trim().split('\n').slice(-2).join('\n  ')}` : '';
    console.warn(`warning: ${chrome} exited before any check ran (${outcome.error});${lastLines}\n` +
      `  falling back to the pinned chrome-headless-shell ${HEADLESS_SHELL_BUILD}.`);
    metadata.browserFallbackFrom = chrome;
    metadata.browserBinary = await downloadHeadlessShell();
    await writeFile(reportPath, JSON.stringify({ ...metadata, status: 'running' }, null, 2));
    ({ outcome, stderr } = await attempt(metadata.browserBinary));
  }
  const { early, ...recorded } = outcome;
  await writeFile(reportPath, JSON.stringify({ ...metadata, status: outcome.ok ? 'passed' : 'failed', ...recorded }, null, 2));
  if (!outcome.ok) throw Error(outcome.error + '\n' + stderr);
  console.log(`Diff browser ${performanceMode ? 'performance' : 'layout'} checks passed:`, JSON.stringify(outcome.summary || outcome.results));
  console.log('Report:', reportPath);
} finally {
  server.closeAllConnections(); server.close();
}
