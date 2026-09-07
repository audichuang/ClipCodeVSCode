# Lower progressive Diff update cost

Base: `dd73d77`. The user permits larger dependencies if they reduce runtime rendering pressure. This change uses the already-installed Svelte reactive Map and retains Shiki 4.4.3; no dependency or DOM-node additions are required.

## Measured cause and change

Every 200-line highlight batch replaced the entire HTML Map. In addition, the partially revealed hunk was a new object each time, and every existing line directly read its `oldStart`. Replacing the Map alone did not solve the redundant work: the first experiment using only SvelteMap still reevaluated the old rows.

The final change publishes individual HTML keys through SvelteMap and derives stable primitive hunk/line indices before using them in the template. It removes the growing Map copy from every batch. Obsolete keys are pruned once per pass so cancelled file changes cannot grow the cache indefinitely. Theme changes clear old entries before the first new-theme batch, preventing a refresh from reusing a mixed-theme tail.

A runnable regression on the actual mounted FileDiffView counted 18 bottom-level cache reads for the first row during a 3,000-row inline reveal before the change, versus 6 afterward. The count includes reactive Map bookkeeping; it is not a DOM mutation or paint count. Both inline and side-by-side now have bounded old-row read tests. The old implementation was run and failed the original regression before applying the fix.

## Paired benchmark

Seven alternating before/after pairs after an excluded warm-up, same process, same 3,000-line fixture, deterministic mocked syntax HTML. Mounted actual old/new Svelte components in happy-dom and measured until all 3,000 highlighted rows existed. This isolates component/DOM-construction work from Shiki and Git. It does **not** measure browser layout, GPU paint, FPS or end-to-end VS Code latency.

| | Median | Samples (ms) |
|---|---:|---|
| Before | 354.6 ms | 403.8, 376.2, 349.9, 337.7, 374.7, 340.5, 354.6 |
| After | 327.4 ms | 377.9, 348.7, 327.4, 311.2, 330.4, 316.1, 316.6 |

About **7.7% less measured component/DOM-construction time** in this fixture. No claim is made that memory usage fell: reactive per-key bookkeeping trades some metadata for fewer invalidations. The temporary benchmark files were moved out of the repo; evidence is `/tmp/render-paired.log`, `/tmp/render-perf.tmp.test.ts`, and `/tmp/_PerfBaseline.svelte`.

## Verification

- Full graph suite: **2,476 passed / 11 skipped**, all 162 test files passed.
- Svelte check: **0 errors / 0 warnings**. Graph TypeScript check passed.
- Existing local VS Code E2E: **7 passed**.
- Regressions cover bounded old-row reads in both layouts, first-screen/complete reveal, no-grammar fallback, file switching, same-file refresh without blanking unchanged rows, and a theme pass interrupted by another refresh.
- Native VS Code: opened a real 3,000-line TypeScript diff (1,500 deleted + 1,500 added) in the isolated fixture repo. Scrolled to the final added row (line 1,500), confirmed full highlighting, switched to side-by-side, then from High Contrast Light to Dark Modern. Both ends and both panes displayed correctly.
- Native mutation smoke: switched to the two-hunk navigation fixture, clicked Stage Hunk then Unstage Hunk. The unchanged hunk remained rendered; scope returned to 0/0 and both hunks remained available. No cat files were staged or edited.
- Packaged as `clipcode-vscode-0.3.45-render-pressure-unreleased.vsix`; no version change, commit, push or release tag.

## Package decision

The prior package audit is `2026-09-07-perf-audit.md`; its tokenizer comparisons are earlier evidence, not newly rerun here. This round found avoidable UI invalidations using the existing stack, so adding a larger editor/tokenizer would not address the measured cause. Worker offloading, different tokenizers and stateful two-stream highlighting are not implemented in this patch. Larger bundles remain acceptable if a future controlled benchmark demonstrates a worthwhile gain without sacrificing Diff behavior.
