# Hybrid highlighter worker — implementation and verification

Base: `4a9f42e`. User priorities: startup, first colored Diff, responsive large-file display and Git reads; larger packaging is acceptable only for measurable benefit.

## Shipped behavior in this working tree

- The first screen stays on the existing local Shiki path. Worker startup is never awaited by rendering.
- A highlighted file over 400 lines lazily starts one worker for that webview. Only uncached tail batches of at least 64 lines are offloaded once its grammar is ready; a batch has at most 200 lines. Small files and cached edits stay local.
- The worker uses the same Shiki version, themes and word-range HTML functions. It is an independent IIFE with all grammars and WASM inlined, fetched only from the host-provided extension resource URL and executed as a blob worker.
- File/theme changes abort pending requests; request IDs and the existing stale-result guard reject late HTML. Worker startup/request timeouts and worker failure preserve local highlighting. Worker and blob resources are released on page teardown/error.
- No Git engine, mutation logic or additional npm dependency was introduced. The existing measured discovery improvements remain in place. A Rust Git replacement has no demonstrated end-to-end advantage in this workspace yet.

## Actual VS Code measurement

Temporary probes ran inside the actual webview and host. Host `show()` supplied the start timestamp; animation-frame observations identified the first colored content and complete expected row set. A 4ms timer measured scheduling delay after the first colored content. These are instrumented webview measurements, not hardware presentation timestamps or FPS.

The test used a separate VS Code profile with background timer/renderer/occlusion throttling disabled. Earlier default-profile measurements suffered background throttling and were excluded. Both compared modes used the same instrumented build; baseline omitted the worker resource URL, activating the local fallback. Each paired sample created a new Diff webview/highlighter. The extension host, filesystem and resource caches were warm: **this is not an uncached whole-process cold-start benchmark**.

| Scenario | Local baseline median | Hybrid median |
|---|---:|---:|
| 3,000-line Diff, first colored content, 5 pairs | 164ms | 152ms |
| 3,000-line Diff, complete colored content, 5 pairs | 1,509ms | 1,301ms |
| Median of maximum post-first-screen timer delay | 440.1ms | 215.4ms |
| 16-line Diff, first colored content, 3 pairs | 135ms | 128ms |

Large-file completion improved approximately **13.8%** in these runs; first-screen timing did not regress. Small-file differences are minor and should not be sold as a distinct speedup. Worker mode actually offloaded 3–5 batches in each measured large-file new-page run. Small files offloaded none. An exploratory warm navigation offloaded 15 batches; it is not part of the paired summary.

Raw measurements, including excluded runs and their context: `2026-09-08-hybrid-worker-native.json`. The first isolated Worker run offloaded zero batches while the worker warmed; it was excluded as warm-up, not represented as a first-ever-launch gain. No claim is made that every machine, first installation or remote connection gets the same benefit.

All temporary timing code, mode-file reads and diagnostic globals were removed before the final build. The production client differs from the timed prototype only by adding a bounded fetch timeout and removing diagnostics. The existing first-screen path remains the fallback throughout startup.

## Verification

- Host: **185 passed**, 0 failed.
- Graph: **2,482 passed**, 11 skipped; all 163 test files passed.
- Svelte: 0 errors / 0 warnings after the final lifecycle regression; graph TypeScript check passed.
- Existing local VS Code E2E: **7 passed**.
- `node scripts/verify-highlight-worker.mjs`: actual bundled worker output equals local helper output in **10 cases** (5 languages × 2 themes, Unicode and word ranges).
- Tests cover startup/local fallback, small batches, cancellation, late response IDs, worker error, vanished-response timeout, missing worker resource, and a late worker batch after FileDiffView navigation. Existing first-screen, full reveal, theme and no-flash tests remain green.
- Independent Spec and Standards/Safety reviews found no blocking issue. A running synchronous batch cannot be preempted halfway through; cancellation stops accepting its result and subsequent work, with a 200-line batch bound.
- Native timed runs verified all 3,000 expected rows were present and colored. After removing probes, the large-file first screen rendered correctly and real Stage Hunk / Unstage Hunk on the small fixture returned scope to 0/0 with the same Diff selected.
- Native tests used only disposable repositories for Git mutations. Cat remains a read-only workspace for the final demonstration.
- The separate benchmark profile was closed afterward; the final development build was reopened on cat using the normal desktop profile.

## Packaging and limits

VSIX: `clipcode-vscode-0.3.45-hybrid-worker-unreleased.vsix`. Previous render-pressure VSIX: **1,754,802 bytes**; new VSIX: **2,337,220 bytes**, about 582KB larger. Version remains 0.3.45; no release tag or publish action.

Every packaged host/webview asset byte-matches the tested final build. `workbench.js` is byte-identical to the prior render-pressure VSIX. The original three classic view bundles remain separate; `highlight-worker.js` is an additional background asset. MainPanel/DiffPanel permit blob workers and extension-resource fetches, while the commit box/sidebar CSP stays unchanged.

The extra worker retains another Shiki/WASM instance after a large file is opened. Memory reduction was not measured or claimed. Complete renderer-thread work is not eliminated: HTML insertion, layout and word-range preparation remain local. Fully uncached application startup and SSH latency need separate measurements; this patch makes no universal “fastest possible” claim.

Git reads were not replaced with Rust merely to add a dependency. Prior real-cat discovery measurements remain approximately 44ms and the patch changes neither those code paths nor the sidebar's startup bundle. Follow-up Git work should target a newly measured bottleneck rather than assume a language change improves filesystem or subprocess costs.
