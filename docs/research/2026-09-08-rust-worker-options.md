# Rust, WASM and other performance directions

Research date: 2026-09-08. The previous render-pressure change was committed and pushed as **4a9f42e** before this investigation. This document and the research probe are new, uncommitted work; no Rust dependency or worker has been integrated into the product.

## Recommendation

First prototype **streaming Shiki in a webview Web Worker**, evaluating interaction latency rather than only completion speed. Keep **stateful old/new token streams** as the next CPU-reduction experiment. If a Rust component is still worth trying afterward, benchmark `syntect` for highlighting or a narrowly scoped `gix` helper for Git reads. None is a drop-in replacement for the current UI or safe hunk-staging implementation.

Installing another VS Code extension would not automatically accelerate Snipcode's private webview. An exported extension API, Rust library, WASM module or native helper needs an explicit integration at the relevant computation boundary.

## Existing engine versus execution location

The current Shiki engine is already Oniguruma compiled from C to WASM. Shiki's official performance guide recommends workers for CPU-heavy highlighting. My inference: changing the implementation language alone does not remove synchronous work from the UI thread; where it runs is a separate decision. [Shiki performance guide](https://shiki.style/guide/best-performance)

VS Code webview workers must load through blob/data URLs and cannot depend on runtime `importScripts`/dynamic imports according to the official guide. A prototype therefore needs a self-contained worker bundle, scoped CSP adjustments, request generations and cancellation, plus resource cleanup. This fits the user's allowance for a larger bundle, but it adds startup and memory costs that must be measured. [VS Code webview workers](https://code.visualstudio.com/api/extension-guides/webview#using-web-workers)

The prior audit rejected a worker as a first-screen optimization. This investigation revisits it because the user's expanded objective includes keeping interactions responsive during background work. Those are different acceptance criteria; the new experiment does not establish a faster cold first paint.

## New local experiment

Executed a Node worker prototype with the installed Shiki 4.4.3, the same 3,000 TypeScript source lines, oniguruma and dark-plus. Both engines were warmed. Five alternating-order trials per mode; a 4ms interval records each run's maximum scheduling delay. Worker output was byte-for-byte equal to the main-thread HTML (1,038,197 bytes). Input cloning, chunk delivery and output accumulation are included in worker request completion time.

| Mode | Median total | Median of per-run maximum timer delay |
|---|---:|---:|
| Synchronous full-file control, not the current product | 198.9ms | 195.0ms |
| Simulated current chunk sizes: first 60, then 200 + yield | 213.8ms | 12.7ms |
| Streaming worker, same chunks | 198.3ms | 1.0ms |

**Interpretation:** offloading is a promising way to lower scheduling pressure while retaining the existing colors. It does not inherently reduce CPU usage. This is Node worker_threads, not a browser worker or actual webview measurement; no layout, DOM patching, word-range overlays, frame timings or remote transport are included. Worker startup plus deliberate full-fixture warm-up took 476ms outside the request measurements; that is not a production startup estimate. Cold first paint, memory and cancellation remain unverified.

Reproduce after installing repo dependencies:

```sh
node scripts/bench-highlight-worker.mjs /tmp/snipcode-worker-probe.json
```

Recorded samples: `2026-09-08-worker-probe.json`. The script is research-only and excluded from VSIX by the existing `scripts/**` rule.

## Candidate assessment

| Candidate | What it could replace | Assessment |
|---|---|---|
| **syntect** | Syntax parsing/highlighting | Real Rust candidate; uses Sublime syntax definitions. Color/grammar parity with current VS Code TextMate output must be verified, not assumed. Its README reports the pure-Rust fancy-regex mode as roughly half the speed of its default Oniguruma mode, so “Rust + WASM” is not an automatic speed win. This is the project's claim, not our benchmark. [Official repository](https://github.com/trishume/syntect) |
| **syntastica** | Tree-sitter highlighting pipeline | Rust/Tree-sitter candidate with parser collections and WASM support. Requires parser/query/theme selection and different syntax-context behavior; evaluate actual Java/TS/SQL diff fragments. Its main library does not include parsers by itself. [Official repository](https://github.com/RubixDev/syntastica) |
| **gix / gitoxide** | Repository/object/status reads | Appropriate Rust library candidate for a persistent read-only helper that batches operations. The maintainers recommend the gix library for applications and warn that the CLI interfaces can remain unstable. Our complete cat discovery is already ~44ms, so a larger replacement needs an end-to-end win on actual larger repositories. Preserve Git CLI for mutations until parity is demonstrated. [Official repository](https://github.com/GitoxideLabs/gitoxide) |
| **NAPI-RS** | Bridge between Node and Rust | An integration mechanism, not a faster renderer. AsyncTask provides off-thread Rust computation; synchronous addon calls do not solve blocking by themselves. Native platform artifacts and the local versus SSH extension-host location still need handling. [AsyncTask](https://napi.rs/docs/concepts/async-task), [package setup](https://napi.rs/docs/introduction/simple-package), [VS Code remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions) |
| **Difftastic** | Optional structural comparison | Useful for a different semantic view, not a performance replacement for patch generation. Its output is for people and does not generate applicable patches; current hunk/line staging must retain its exact Git patch model. [Official repository](https://github.com/Wilfred/difftastic) |
| **inkjet** | Tree-sitter highlighting | Not recommended as a new dependency: GitHub marks the repository archived. [Official repository](https://github.com/Colonial-Dev/inkjet) |

GitHub metadata checked on the research date: syntect, gitoxide, syntastica and napi-rs were not archived; inkjet was archived. Licensing needs a component-level review if an option is adopted (including bundled grammars); top-level metadata alone is not an adoption decision.

No Rust candidate was compiled or benchmarked in this investigation, so no comparative Rust speedup is claimed.

## Other directions and acceptance criteria

1. **Worker prototype in the actual webview:** compare cold/warm first-colored frame, p95 input delay while the tail streams, total completion, heap, and disposal. Test both full graph and Diff, rapid file/theme switches, unavailable-worker fallback, and hunk/line mutations. Prioritize visible rows and cancel obsolete work. A warm Node result is only the reason to run this experiment, not a shipping verdict.
2. **Stateful highlighting:** Shiki already supports carrying GrammarState. For a unified diff, old and new streams must be independent and restart at hunk gaps. Cache identity must include the relevant state/context, or changing an earlier comment boundary would leave later lines incorrectly colored. This can reduce parsing work and fix multiline context but is separate from worker offloading. [Shiki Grammar State](https://shiki.style/guide/grammar-state)
3. **DOM/layout only if profiling still identifies it:** virtualization would require replacing DOM-based hunk navigation/counting/selection with data-based identities. Rust cannot execute the webview's DOM layout in place of Chromium. Keep the existing native full-file Diff entry as an option for inspection; its behavior is not interchangeable with custom partial staging.
4. **Read-only Rust Git helper only after new evidence:** benchmark working-tree status, history and object reads independently, and compare rename, conflicts, linked worktrees, submodules, encodings and SHA-256 results. Reusing the CLI's safety/locking/credential paths is more important than deleting a few fast spawns.

Research tooling: agent-reach's Exa backend was unavailable in this configuration, so searches used the web tool and official GitHub metadata via gh. Agent Reach's update check could not resolve DNS; no tooling updates were performed.
