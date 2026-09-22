# Diff Webview invariants and regression checks

A happy-dom green result does not prove rendered geometry or real VS Code lifecycle behavior. Use these layers together.

## Rendering invariants

- **Replace immutable snapshots.** `DiffStore` keeps staged and unstaged data in
  `$state.raw` to avoid deep proxies for every hunk and line. Publish new snapshots
  through `setDiffs`; in-place edits to nested lines do not notify consumers.
  Changes to this ownership model must preserve UI updates on replacement.
- **Pair once, reveal progressively.** `FileDiffView` pairs side-by-side rows from
  the stable `renderHunks` line arrays, then reveals complete pairs in stable
  groups. Pairing freshly sliced prefixes on every batch defeats the identity
  cache and repeats work over all visible rows. Preserve reveal progress across
  inline/side-by-side switches and same-file refreshes; preserve existing DOM
  where content remains so focus and stage actions keep their intended targets.
- **Keep reveal independent of worker availability.** The first batch highlights
  locally; a ready worker may process later uncached batches, with local fallback
  on worker failure. The reveal loop must also finish when highlighting is
  unavailable or already cached. File, theme and mode changes, and unmounting,
  invalidate the old paint pass: abort pending worker requests and check whether
  work is still current before publishing results. Cancellation alone cannot
  prevent a late reply from repainting the current view.

## Fast lifecycle and protocol checks

```sh
npm --prefix graph test -- DiffPanel.test.ts messaging.test.ts Diff.test.ts \
  CommitDetails.test.ts FileDiffView.lifecycle.test.ts highlight-worker-client.test.ts
```

- `DiffPanel.test.ts`: latest navigation before ready, late image replies, disposal, stage hunk/line failures after file/repo changes, and same-target refresh retaining the operation's error reply.
- `messaging.test.ts`: operation correlation and busy state at the receiving boundary.
- `Diff.test.ts`: displayed statistics update when a new diff snapshot replaces the old one.
- `CommitDetails.test.ts`: truncation, its banner, and actual tail rows after expanding the full diff.
- `FileDiffView.lifecycle.test.ts`: stale result rejection after unmount/theme/mode changes, progressive reveal, row/cache reuse, replacement-pair boundaries, focus and stage line indices.
- `highlight-worker-client.test.ts`: worker request cancellation/failure handling.

Control races with deferred promises; do not use elapsed sleeps to assume completion. Test both rejection of obsolete replies and acceptance of a current reply. In particular, an unconditional generation check can strand a current operation when the same file is refreshed.

The host guard is defense in depth: correlated stale errors are also rejected by the current webview consumer. Keep host and consumer contracts independently covered, including messages without an operation id.

For progressive-reveal tests, distinguish product rendering cost from observation
cost: repeatedly scanning all descendants of a growing DOM can make the assertion
itself quadratic. Use a bounded probe that still verifies actual rows; expanding
"show full diff" must reveal the tail, not just dismiss the banner. `waitFor`
callbacks must assert (throw until ready), with an explicit timeout below the
enclosing test's timeout. These waits check functional completion; performance is
measured by the browser gate below, so a timeout alone does not identify a product
bottleneck.

## Real browser layout

```sh
npm run test:diff-layout
```

Needs no preinstalled browser. `CHROME_BIN` wins if set; otherwise the first browser actually present is used — the Chrome and Chromium app bundles then PATH on macOS, the Chrome and Edge install directories under Program Files / Program Files (x86) / LocalAppData then PATH on Windows (neither adds itself to PATH on a stock install), and chromium / chromium-browser / google-chrome / google-chrome-stable / chrome via PATH on Linux. It used to hardcode the bare name `chromium` off macOS, so a box with Google Chrome and no `chromium` could not run this gate at all — and that reads like a skipped gate rather than a missing one. A browser the gate FOUND on this machine that dies before any check runs (seen: a Homebrew-cask Google Chrome exiting with `FATAL … Failed to get the path for 1001` in headless mode) falls back to the pinned shell with a warning, and the report records both `browserBinary` and `browserFallbackFrom`; `CHROME_BIN` never falls back, and a timeout never does — that can be the webview hanging. With no local browser at all, the pinned `chrome-headless-shell` build in `scripts/verify-diff-layout.mjs` (`HEADLESS_SHELL_BUILD`) is fetched into the gitignored `.cache/browsers/` — repo-local, never installed system-wide, and reused without network on later runs. A gate only some machines can run is the same class of bug as a test only some machines can pass, which is why the download exists; but a browser that cannot be obtained is still a failure, never a silent skip. The build is pinned rather than resolved to today's stable because the budgets below are read against that binary — it is more reproducible than whatever Chrome a given machine last updated to, and the executable path is recorded in the report. The download honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` and extracts without a system `unzip`, because `proxy-agent` and `yauzl` are installed as devDependencies — optional peers of `@puppeteer/browsers` that nothing in this repo imports, so a dependency audit will call them unused; removing either brings the machine dependency back. What a download cannot supply is still a prerequisite on Linux: the shared libraries Chromium links against (`libnss3` and friends; a root shell can install them with `npx @puppeteer/browsers install chrome-headless-shell@154.0.8037.57 --install-deps`, which the gate deliberately never runs), and a non-root user, since Chromium refuses to start as root without `--no-sandbox` and this gate never passes it. This command builds current Webview assets first, serves only those assets on localhost, launches an isolated temporary headless browser profile and removes it afterward. It does not use the user's browser profile. Profile removal retries (Chrome's children can still be writing into it) and, if it ultimately fails, warns and leaves the temp directory behind rather than changing the exit code — cleanup must never overwrite the real verdict, in either direction.

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
small navigation (14 hunks), large navigation (144 hunks), same-file refresh,
large-file theme changes, and a newly added file with one 3,000-line hunk.
The single-hunk case uses the same budgets as large navigation and catches work
that repeated small hunks can hide. Each sample requires the expected nonempty line count,
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
reviewable budget edit, not environment overrides. A browser that can be neither found nor fetched, or a timeout,
fails the command. The fallback download is repo-local and gitignored; no test installs a
browser system-wide, changes the user's browser profile, or disables the sandbox. Bumping
`HEADLESS_SHELL_BUILD` is an intentional, reviewable edit, exactly like a budget edit.
