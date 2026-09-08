# Diff Webview regression checks

A happy-dom green result does not prove rendered geometry or real VS Code lifecycle behavior. Use these layers together.

## Fast lifecycle and protocol checks

```sh
npm --prefix graph test -- DiffPanel.test.ts messaging.test.ts FileDiffView.lifecycle.test.ts highlight-worker-client.test.ts
```

- `DiffPanel.test.ts`: latest navigation before ready, late image replies, disposal, stage hunk/line failures after file/repo changes, and same-target refresh retaining the operation's error reply.
- `messaging.test.ts`: operation correlation and busy state at the receiving boundary.
- `FileDiffView.lifecycle.test.ts`: pending highlighting after unmount, pure theme changes while a worker is pending, stale result rejection, progressive reveal and cache reuse.
- `highlight-worker-client.test.ts`: worker request cancellation/failure handling.

Control races with deferred promises; do not use elapsed sleeps to assume completion. Test both rejection of obsolete replies and acceptance of a current reply. In particular, an unconditional generation check can strand a current operation when the same file is refreshed.

The host guard is defense in depth: correlated stale errors are also rejected by the current webview consumer. Keep host and consumer contracts independently covered, including messages without an operation id.

## Real browser layout

```sh
npm run test:diff-layout
```

Requires installed Chrome/Chromium. On macOS the default is Google Chrome; on Linux it is `chromium`. Set `CHROME_BIN` to override the executable. A missing browser is a failure, never a silent skip. This command builds current Webview assets first, serves only those assets on localhost, launches an isolated temporary headless browser profile and removes it afterward. It does not use the user's browser profile.

The actual production `diff.js` and `diff.css` receive a simulated host handshake and staged/unstaged fixture containing replacements, unequal additions/deletions, blank context lines, and long lines. Checks cover:

- Actual rendered font matches 12, 14, 20 and 24px.
- Every corresponding left/center/right row has matching Y position and height at 1200px and 430px container widths.
- Unchanged context is not marked as changed.
- Chinese staged action retains its semantic class.
- Expanded hit area exists.
- Horizontal scrolling synchronizes both panes without moving the center lane.

This test intentionally measures behavior, not whether a particular CSS declaration exists. Its regression sensitivity was verified by temporarily changing generated `min-height:max(20px,1.5em)` rules back to 20px: it failed at 14px with an 8px mismatch; restored assets passed all eight combinations. The unmount test similarly fails when its stale-result guard is removed. Never keep mutations in source or built output.

## Integration and manual acceptance

```sh
npm --prefix graph test
npm test
npm run build:host
node scripts/verify-highlight-worker.mjs
```

For native UI acceptance, reload the development host after building and verify the loaded asset path. Use disposable Git fixtures for mutations. Check keyboard focus/navigation, stage/unstage read-back, narrow windows, actual VS Code themes and closing during work. Headless layout tests cannot prove the native host's CSP, extension process restart, workspace trust, or screen-reader experience.

Measure performance separately: record cold vs warm state, first colored frame vs complete reveal, file/hunk counts and repeated samples. Do not assert a hardware-specific 25ms budget in a unit test. A smaller batch size alone is not proof of lower long-task latency; use browser performance measurements.

## Automated performance gate

```sh
npm run test:diff-perf     # rebuild current Webview, then benchmark
npm run test:diff-ui       # one build, layout checks and performance gate
npm run test:precommit     # required before committing; includes all the above
```

`test:precommit` runs host and full graph tests, builds the host, rebuilds the Webview,
checks browser layout/performance and verifies worker parity. Run it after the last
edit; a previous report from a different build is not evidence. This is an agent
commit policy and a command, not an installed Git hook.

The browser performance gate uses deterministic SQL payloads through the production
message listener. It measures one fresh-page sample plus three samples each for
small navigation (14 hunks), large navigation (144 hunks), same-file refresh, and
large-file theme changes. Each sample requires the expected nonempty line count,
current fixture marker and real syntax spans. Theme changes must replace every old
line's highlighted HTML. It waits for a subsequent animation frame before declaring
completion. Long Tasks API support and a deliberate blocking probe are required;
a missing observer cannot silently report zero work.

- Cold timing starts when Chromium requests the document, includes bundle loading,
  parsing and fresh highlighter setup. Pre-request Chromium startup remains in the
  navigation timing report but is not attributed to product rendering.
- Warm timing starts at the simulated host update. These figures isolate Webview
  rendering; they do not include real Git queries, IPC, VS Code startup or GPU
  presentation. Native acceptance still covers those boundaries.
- The JSON includes individual samples, medians, maximum long tasks, frame gaps,
  total blocking time, browser version, CPU, timestamp and built asset hashes.
- Reports: `test-results/diff-layout.json` and `test-results/diff-performance.json`
  (ignored build artifacts). `running` or `failed` is not a pass.

Budgets live in `scripts/diff-performance-budgets.json`. First/full-frame limits
apply to medians; long-task limits apply to the worst observed task in that case.
The initial gates are cold first/full 1000/2000ms, small 250/750ms, large 250/2000ms,
refresh 250/1000ms, theme 500/1500ms, with 150ms long-task limits (250ms cold).
These catch major regressions; passing does not mean every frame meets 16ms or that
all work is under 25ms. Preserve the raw long-task/frame-gap data for review.

Run on an otherwise idle machine without concurrent builds/tests. When a budget
fails, retain the failing report and diagnose the change; do not repeatedly rerun
until one run passes or raise limits merely to permit a commit. Browser/CPU changes
must be recorded and evaluated explicitly. Gate changes require an intentional,
reviewable budget edit, not environment overrides. Missing Chrome or a timeout fails
the command. No tests automatically install a browser or disable its sandbox.
