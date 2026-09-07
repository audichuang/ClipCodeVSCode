# Performance verification — dd73d77

Reviewed on macOS, 2026-09-07, against `cc81e04...dd73d77`: `b3363fa` (discovery, Diff warm-up / refresh ordering, failure message) and `dd73d77` (Shiki 4.4.3). Fast-forward pull completed. No product changes, commit, push or release performed in this review.

## Verdict

The measured performance gains are real. No new blocking correctness regression was found in the reviewed paths or executed tests. Keep the current optimizations; another rendering rewrite is not justified by these results.

## Measurements

Seven paired trials, alternating old/new order, after warm-up. These are isolated operation measurements, not end-to-end VS Code startup or first-paint timings.

| Measurement | Before | After | Interpretation |
|---|---:|---:|---|
| cat one root, first discovery batch | 35.3 ms | 36.2 ms | Essentially unchanged |
| cat one root, complete discovery (25 repos) | 311.1 ms | 43.7 ms | 86% reduction |
| 24 roots, complete discovery (26 repos) | 332.2 ms | 49.8 ms | 85% reduction |
| Shiki warmed TS tokenisation, 3,000 separate lines | 374.1 ms | 196.9 ms | About 1.9x throughput |

Discovery uses the actual cat directories, clears the service cache between trials and keeps the filesystem warm. Shiki uses the same first 3,000 lines of `git-service.ts`, dark-plus and oniguruma in both versions; it does not thread grammarState across lines, matching the current per-line call pattern. Old Shiki was installed only in `/tmp/snipcode-shiki-old-bench`; the project uses the new lockfile and verified version 4.4.3.

Raw measurements: `/tmp/snipcode-cc81-dd73-discovery-benchmark.json` and `/tmp/dd73-shiki-benchmark.json`. Reproduction script for tokenisation: `/tmp/dd73-shiki-bench.mjs`.

## Tests and real UI

- Host: **185 passed**, 0 failed.
- Graph: **2,473 passed**, 11 skipped; all 162 test files passed.
- Svelte check: **0 errors, 0 warnings**. Graph TypeScript check passed.
- Existing local VS Code E2E: **7 passed**.
- Shiki API smoke: all **34 grammar loaders × 2 themes** load and tokenise; token text reconstructs the input in all 68 cases. This checks compatibility, not identical grammar colours across major versions.
- Native VS Code development host was rebuilt from the new dependencies. In cat, Java `ExportController.java` opened as a coloured custom Diff with the expected two hunks, and the sidebar followed the selected repository.
- In the disposable `/tmp/snipcode-loading-fixes-qa/native-cases` repo, clicked Stage Hunk: one staged and one unstaged hunk appeared and scope became 1 repo / 1 file. Clicked Unstage Hunk: both returned to Unstaged and scope became 0/0; the same Diff stayed selected, with no stuck busy state. The index was empty again afterward; no commit was made.
- Dark Modern was inspected in cat; High Contrast Light was inspected on the TypeScript fixture. Highlighting, count badge, sidebar repo identity and hunk controls rendered normally.
- UI automation observation latency is not a reliable first-paint clock. This review therefore does not independently certify the audit's exact 129ms-to-89ms first-screen figure. The newly added initial `diffLoading` message and mutation-before-panel-before-tree ordering are covered by the committed regression tests and source review.

Cat was used read-only. The development host is left on the cat test workspace. Git mutation tests use isolated fixtures only.

## Standards / backend

No confirmed new standards violation or backend regression. The four hunk/line mutation paths still finish the mutation before refreshing the current Diff, preserve operation IDs and target guards, and then refresh the tree. The old-Git empty-tree fallback retains a usable SHA-1 result when object-format probing is unsupported.

The submodule shortcut has an explicitly documented limit: a linked worktree with its tracked `.gitmodules` removed from the working tree can be missed because `.git` is a file. This rare case was not independently reproduced in native VS Code; it remains a stated coverage limit rather than a blanket claim that every submodule layout was verified.

## Spec / UI and remaining improvements

No confirmed new UI/protocol defect. Two remaining improvements are worth tracking separately:

1. **Scope failure messaging covers rejected loaders, not every Git status failure.** Normal per-repo failures become error rows inside `readRepoStatus`. A real isolated corrupt-index reproduction returned `ready=true`, `failed=false`, one error group. Strict commit still rejects the failed repository, so no unintended commit was established. A future small improvement could mark the scope as incomplete/failed when error rows exist, making the commit box agree with the tree. Evidence: `/tmp/snipcode-actual-status-failure.json`.
2. **Multiline syntax context is still a known limitation.** Stateless per-line tokenisation cannot carry a block comment/string into following lines. Shiki 4.4.3 improves throughput but does not solve this. Any follow-up must maintain separate old/new grammar streams per hunk and update cache keys; do not trade away correct staging/refresh behavior merely for another benchmark gain.

Review totals: no new blocking finding on either axis; one demonstrated existing UX gap and documented syntax/submodule coverage limits remain.
