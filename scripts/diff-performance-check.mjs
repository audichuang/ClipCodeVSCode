// Serialized into the isolated browser by verify-diff-layout.mjs.
export async function checkPerformance(budgets) {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const emit = data => window.dispatchEvent(new MessageEvent('message', { data }));
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const samples = [], longTasks = [];
  const entryMs = performance.now();
  let observer;
  try {
    assert(JSON.stringify(Object.keys(budgets).sort()) === JSON.stringify(['cold', 'large', 'refresh', 'small', 'theme']), 'Missing or unknown performance workload budget');
    for (const limits of Object.values(budgets)) {
      assert(JSON.stringify(Object.keys(limits).sort()) === JSON.stringify(['firstMs', 'fullMs', 'maxLongTaskMs']), 'Missing or unknown performance metric budget');
    }
    assert(PerformanceObserver.supportedEntryTypes.includes('longtask'), 'Browser lacks Long Tasks API');
    observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()));
    observer.observe({ type: 'longtask', buffered: true });
    await window.diffReady;
    assert(document.querySelector('.diff-app-root'), 'Production Diff failed to mount');
    let generation = 0;
    const fixture = (file, count, marker) => ({
      file, isBinary: false, isImage: false, fingerprint: marker,
      hunks: Array.from({ length: count }, (_, i) => {
        let old = i * 25 + 1, next = old;
        const entries = [
          ['context', `-- ${marker} query ${i}`],
          ['context', 'select CustomerID, CustNM, SendDate'],
          ['context', ''],
          ['delete', "  '電子交易報告書' as BILL_TYPE,"],
          ['add', "  '電子交易報告書' as BILL_SUBJECT,"],
          ['context', "  '退件' as REASON,"],
          ...(i % 3 === 0 ? [['add', "  'ER' as BILL_TYPE,"], ['add', "  '電子寄送' as DELIVERY_METHOD,"]]
            : i % 3 === 1 ? [['delete', '  1 as TableOrder'], ['add', "  case when EventLog in (1, 2) then 'PB'"],
              ['add', "       when EventLog = 3 then 'P'"], ['add', "       when EventLog = 4 then 'PR'"],
              ['add', "       else 'P'"], ['add', '  end as BILL_TYPE,']]
            : [['delete', "  and CustStatus = '0'"], ['delete', '  and BranchID = :BranchID'], ['delete', '  and CustNM is not null']]),
          ['context', 'from QA.dbo.Customer C with (nolock)'],
          ['context', 'left join QA.dbo.SendLog S on S.CustomerID = C.CustomerID and S.BranchID = C.BranchID'],
          ['context', 'where SendDate between :StartDate and :EndDate'],
          ['context', ''],
        ];
        const start = old;
        const lines = entries.map(([type, content]) => ({ type, content,
          ...(type !== 'add' ? { oldLineNumber: old++ } : {}),
          ...(type !== 'delete' ? { newLineNumber: next++ } : {}) }));
        return { header: '@@ benchmark @@', oldStart: start, newStart: start,
          oldLines: old - start, newLines: next - start, lines };
      }),
    });
    async function run(kind, diff, { cold = false, refresh = false, theme } = {}) {
      const expected = diff.hunks.flatMap(h => h.lines)
        .reduce((n, l) => n + (l.content.trim() ? (l.type === 'context' ? 2 : 1) : 0), 0);
      const before = theme ? [...document.querySelectorAll('.line-content')]
        .filter(e => e.textContent.trim()).map(e => e.innerHTML) : null;
      // Exclude fresh Chromium network-service startup before it requests our page.
      // Keep that delay in the navigation report; cold still includes bundle loading/parsing.
      const start = cold ? performance.getEntriesByType('navigation')[0].requestStart : performance.now();
      let firstMs, maxFrameGapMs = 0, previous = performance.now(), count = 0;
      if (theme) document.body.className = theme;
      else {
        generation++;
        const payload = { repoPath: '/performance-fixture', file: diff.file, generation };
        if (!refresh) emit({ type: 'diffLoading', payload });
        emit({ type: 'diffShow', payload: { ...payload, stagedDiff: null, unstagedDiff: diff } });
      }
      while (performance.now() - start < 15000) {
        await frame();
        const now = performance.now();
        maxFrameGapMs = Math.max(maxFrameGapMs, now - previous); previous = now;
        const nodes = [...document.querySelectorAll('.line-content')].filter(e => e.textContent.trim());
        const changed = (e, i) => !!e.querySelector('span[style]') && (!before || e.innerHTML !== before[i]);
        const current = theme || nodes.some(e => e.textContent.includes(diff.fingerprint));
        if (current && nodes.some(changed) && firstMs === undefined) firstMs = now - start;
        if (current && nodes.length === expected && nodes.every(changed)) { count = nodes.length; break; }
      }
      assert(count === expected && firstMs !== undefined, `${kind}: incomplete/current highlighter output (${count}/${expected})`);
      await frame();
      const end = performance.now();
      longTasks.push(...observer.takeRecords());
      const tasks = longTasks.filter(t => t.startTime + t.duration > start && t.startTime < end).map(t => t.duration);
      samples.push({ kind, file: diff.file, hunks: diff.hunks.length, renderedNonemptyRows: count,
        firstMs, fullMs: end - start, maxFrameGapMs, maxLongTaskMs: Math.max(0, ...tasks),
        totalBlockingMs: tasks.reduce((n, t) => n + Math.max(0, t - 50), 0), longTasksMs: tasks });
      // Separate runs; this settling time is outside the measured interval.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await run('cold', fixture('cold.sql', 14, 'cold-page'), { cold: true });
    for (let i = 0; i < 3; i++) await run('small', fixture(`small-${i}.sql`, 14, `small-${i}`));
    for (let i = 0; i < 3; i++) await run('large', fixture(`large-${i}.sql`, 144, `large-${i}`));
    let last;
    for (let i = 0; i < 3; i++) {
      last = fixture('large-2.sql', 144, `refresh-${i}`);
      await run('refresh', last, { refresh: true });
    }
    await run('theme', last, { theme: 'vscode-light' });
    // Validate the observer itself, outside every measured workload.
    const probeStart = performance.now();
    while (performance.now() - probeStart < 80) { /* deliberate main-thread stall */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    longTasks.push(...observer.takeRecords());
    assert(longTasks.some(t => t.startTime + t.duration >= probeStart && t.duration >= 75), 'Long Tasks observer failed its blocking probe');
    await run('theme', last, { theme: 'vscode-dark' });
    await run('theme', last, { theme: 'vscode-light' });
    const summary = {}, failures = [];
    for (const [kind, limits] of Object.entries(budgets)) {
      const rows = samples.filter(s => s.kind === kind);
      assert(rows.length === (kind === 'cold' ? 1 : 3), `${kind}: missing benchmark samples`);
      const median = key => rows.map(s => s[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
      summary[kind] = { samples: rows.length, firstMs: median('firstMs'), fullMs: median('fullMs'),
        maxLongTaskMs: Math.max(...rows.map(s => s.maxLongTaskMs)), maxFrameGapMs: Math.max(...rows.map(s => s.maxFrameGapMs)) };
      for (const [metric, limit] of Object.entries(limits)) {
        assert(Number.isFinite(summary[kind][metric]) && Number.isFinite(limit) && limit > 0, `${kind}.${metric}: invalid budget/measurement`);
        if (summary[kind][metric] > limit) failures.push(`${kind}.${metric}: ${summary[kind][metric].toFixed(1)}ms > ${limit}ms`);
      }
    }
    await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: !failures.length,
      error: failures.join('\n'), summary, samples, budgets, browser: navigator.userAgent,
      startup: { entryMs, navigation: performance.getEntriesByType('navigation')[0]?.toJSON() },
      warning: 'Headless production Webview with synthetic host replies. Cold starts at document requestStart; excludes Chromium pre-request startup, VS Code process startup and Git/IPC latency.' }) });
  } catch (error) {
    await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: false, error: String(error.stack || error), samples }) });
  } finally { observer?.disconnect(); }
}
