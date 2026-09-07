# Performance audit — sidebar discovery and diff first paint (`cc81e04`)

Two independent read-only audits of the paths `8948ca7` / `a695b87` / `8e9f2d8`
touched, then the three changes worth making. Every number below was measured on
Linux (20 cores, Node 26.8.1, headless Chrome, git 2.43) unless it says macOS,
where it is the author's or reviewer's own figure. **Measured** and **inferred**
are kept apart on purpose — this round guessed wrong twice before measuring.

## What the audit settled

**The single-root discovery "regression" (47ms → 66ms) is measurement noise.**
`8e9f2d8^` and HEAD, same synthetic 25-repo single-root workspace, 15 trials
each: old first batch median 29.3ms (min 26 / max 72), new 30.4ms (min 28.6 /
max 58.7). The 19ms in `2026-09-07-loading-ui-review.md` sits inside one
machine's own spread; that review ran three trials. The single-root code path is
old/new equivalent anyway — `Promise.all` over one element.

**`a695b87`'s 300ms → 118ms is real and reproducible, but it describes the
FIRST file of a language in a webview session.** Production bundle, 3000-line TS
diff: first file 107–115ms, 480 lines 87–89ms (the commit claimed 118 / 89).
Second file of the same language: **36–39ms**. Plain DOM with no highlighting:
32ms. So steady-state open is already near the floor — the gap is grammar
warm-up, not throughput.

**Where the tail goes:** 3000 lines fully painted is 1170ms with highlighting vs
235ms DOM-only, i.e. ~80% tokenising. Per-line `codeToTokens` costs ~33% more
than tokenising in batches (257ms vs 193ms for 3000 lines on shiki 4.4.3, Node)
— a real but non-blocking saving, since the tail streams in behind the first
screen. Why it is not simply taken: see the `grammarState` note below.

## What changed

1. **`getSubmodules` recognises "no submodules" from the filesystem**
   (`services/repo-discovery.ts`). `git submodule status --recursive` is a shell
   wrapper: **41–47ms for a pool of 25** on this box, against **0.5–1.3ms** for
   the two `fs.access` probes that replace it (measured, 3 trials). Those spawns
   gate the slow pass, and since `cc81e04` the slow pass also gates the Commit
   button (`changes-tree.ts` `commitScopeReady`) — so on macOS, where the author
   measured a 1.0–1.4s slow pass for 25 repos, this delay had stopped being
   cosmetic and started blocking the primary action. `.gitmodules` is the
   signal; `.git/modules/` is the second one, for a `.gitmodules` deleted in the
   working tree but still in the index (git lists those gitlinks, the file alone
   would not).

2. **The grammar warm-up now reaches the file that CREATES the Diff panel**
   (`panels/DiffPanel.ts`). `show()` posts `diffLoading` only when `this.ready`
   is already true, and the webview hangs `warmLanguage` off exactly that
   message (`diff.ts`) — so the session's first file tokenised its first screen
   with a cold grammar. Measured hint→first-screen, 3000-line TS diff, 20ms git:
   **129ms with no warm vs 89ms with it.**

3. **Stage/unstage re-renders the Diff panel before the tree refresh**
   (`tree/changes-workbench.ts`, four call sites). `refresh()` re-reads status
   for every repo (~100ms at 25 repos, author's figure) and the Diff tab's busy
   gate only releases when its own push lands, so every hunk click paid the
   whole pool. The panel's read needs nothing from the tree: the mutation ran
   under `runExclusive` and `exec()` already dropped the repo's read cache.
   Guarded by an ordering test that fails on the old order.

Two correctness fixes rode along: `emptyTreeRef()` no longer throws when
`rev-parse --show-object-format` is unsupported (git < 2.29) — `cc81e04` started
calling it for *every* historical diff, not just root commits, so a throw would
have taken out every commit-file comparison instead of one sha256 detail; and a
**failed** status read now says so instead of rendering as the same permanent
"Loading…" a slow one does (`commitScopeFailed` through to `Workbench.svelte`).
The fail-closed commit lock itself is deliberate and unchanged.

## Rejected — with the numbers, so it is not re-litigated

**A richer warm-up snippet.** Tokenising 12 lines that cover
import/class/generic/decorator/template/regex does cut the first real screen to
9.6ms (from 55.8ms with today's one-liner, Node, TS) — but the snippet itself
costs **135ms of the same main thread**, so hint→first-screen goes the wrong
way: with git at 20ms it is **149ms against today's 89ms**, at 50ms 148 vs 104.
Yielding between the 12 lines does not rescue it (87ms at git=20 — inside
noise), because only two or three lines land before `diffShow` arrives. The
current one-line snippet is already sized to the 20–50ms window git actually
takes. It only pays off if git is slow (at 120ms: 145 vs 176), which is not the
common case. **Today's snippet stays.**

Also rejected, each for a reason rather than a preference:

- **Row virtualisation / windowing** — `Diff.svelte` does hunk navigation,
  counting and line selection through DOM queries; DOM-only tail is 235ms, so
  there is nothing to buy.
- **Shiki in a worker** — the first-screen problem is warm-up, not throughput,
  and the HTML round-trip is not free.
- **Splitting grammars out of `diff.js`** — parse + eval + mount is 63–68ms once
  per panel lifetime (singleton panel, `retainContextWhenHidden`).
- **`@shikijs/engine-javascript`** — already measured slower than oniguruma WASM
  (50 lines 340ms vs 94ms); `8948ca7` moved *away* from it.
- **Tuning `STATUS_CONCURRENCY`** — 4 vs unbounded measured flat.
- **A TTL cache in front of `getUncommittedDiff`** — nothing calls
  `clearReadCache` on those `GitService` instances and both watcher debounces
  (500ms + 300ms) are under the 1.5s TTL, so an external `git add` would show
  stale status; in-flight dedupe alone buys almost nothing (the two spawns are
  already parallel).
- **Dropping `PARTIAL_PAINT_MS` to a leading edge** — worth ~35–50ms on the
  first tree paint at the cost of an extra repaint. Judgement call, not taken.
- **Skipping the fast pass's per-directory `rev-parse`** — worth ~25ms
  (measured: 30 → 4ms first batch with the spawn faked out), but `fs.realpath`
  changes path shape on Windows and macOS symlinked mounts, which is exactly the
  class of bug #30 was.
## The package question, answered separately

A second read-only pass asked whether a *different* package beats Shiki +
oniguruma, with more bundle size explicitly acceptable. Answer: no — but the
**version** was two majors behind.

**Taken: `shiki 1.29.2 → 4.4.3`** (`graph/webview-ui/package.json`, one line;
every symbol this repo uses type-checks unchanged). Measured here, 3000-line TS
file, median of 3 on a fully warmed grammar:

| | per line ×3000 | 50-line batches | whole file | cold first line |
|---|---:|---:|---:|---:|
| 1.29.2 | 482ms | 358ms | 372ms | 36.5ms |
| **4.4.3** | **257ms** | **193ms** | **185ms** | 38.5ms |

**1.9× on steady-state tokenising, and the first screen does not move** — cold
compile is unchanged, which is the expected result, not a failed upgrade: the
first-screen cost is grammar compile, and that is warm-up's job. `dist/graph-webview/diff.js`
got **36KB smaller** (3,692,869 → 3,656,919 bytes); the wasm is still inlined
(same `AGFzbQ` blob, no runtime fetch) and the CSP is unchanged.

Token output was compared line by line across the two versions for eight
languages: **typescript, markdown, python, java, kotlin, json bit-identical**;
ruby and cpp differ because their upstream grammars were updated, and the
differences are **improvements** — Ruby's `module Clip` / `class Payload` now
get the type colour `#4EC9B0` instead of `#4FC1FF`, and C++ declarators that
were previously left uncoloured (`kHeader`, `files_`, `done_`, template
parameter `N`, `std::vector<T>`) now get `#9CDCFE` / `#4EC9B0`. Both match what
VS Code's own editor shows. (Feeding TypeScript source to a ruby/cpp grammar,
which is how a naive comparison ends up, reports thousands of "differences" and
means nothing — the check above uses real Ruby and real C++.)

**Deferred, not rejected: `grammarState` between lines.** Threading the grammar
state from one line into the next is measured at **2.3–2.5×** on top of the
upgrade (492 → 196ms per-line on 4.4.3; independently reproduced against raw
`vscode-textmate`, 461 → 197ms), and it exists in the shiki version already
installed. It also fixes a real defect: per-line stateless tokenising cannot see
that a line is inside a block comment or a multi-line string. Two things have to
be designed first, which is why it is not in this change:

1. **A unified diff's lines are two interleaved streams.** State has to flow
   along context+delete for the old side and context+add for the new side, and
   reset at each hunk boundary (hunks skip lines). A single stream would let a
   deleted `/*` comment out an added line. The 2.3× above was measured on 3000
   lines of continuous text; a diff of many small hunks gets much less.
2. **`highlightKey` stops being content-addressed.** `[file, hunkStart, lineIdx,
   content]` assumes a line's HTML depends only on its own text; with state, the
   line before it can change its colours without changing its content. The D7
   reuse cache (which is what keeps a stage/unstage from re-highlighting and
   flashing every other line) needs a new key.

Rejected outright by that pass, with numbers, so none of it needs revisiting:
`@shikijs/engine-javascript` + `@shikijs/langs-precompiled` (2.4× slower than
oniguruma even with build-time precompilation, and 15% of markdown lines
mis-tokenised); `vscode-textmate` + `vscode-oniguruma` by hand (461ms — slower
than shiki 4, and you inherit theme/grammar/colorMap management);
`@wooorm/starry-night` (is that, plus a Node-only resolver);
`web-tree-sitter` (fastest raw parse at 25–42ms, but no theme mapping without
hand-written `highlights.scm` per language, only 21 of 34 languages available,
27MB of grammar wasm, and `rootNode.hasError === true` on a hunk fragment
because it needs whole-file context); Monaco's tokeniser (either the same
`vscode-textmate` path or Monarch's coarse token names); `lowlight` and
`@git-diff-view/core` (both wrap highlight.js); and pre-serialising oniguruma's
compiled regexes, which the API simply does not expose — compiled state lives in
that page's wasm memory and cannot be exported, so **warm-up is the only lever
on the first screen.**

`highlight.js` (70ms) and `prismjs` (43ms) really are 6–7× faster than TextMate
with no cold-compile at all, and would let `workbench.js` highlight too. They are
not taken because they emit ~15 generic classes instead of TextMate scopes: the
colours would visibly stop matching the editor next to them, and `dark-plus` has
no meaning in that world. That is a product trade, not a performance one — worth
re-opening only if someone decides matching the editor does not matter.

**Word diff needs nothing.** 300 real replace-line pairs from this repo's own
history: the current `computeWordDiff` is **2.70ms**, against `diff@9`
`diffWords` 10.16ms, `fast-diff` 11.83ms, `diff-match-patch` 13.69ms, and
`diff@9` `diffChars` 37.46ms. The current implementation is 3.7–14× faster than
every candidate, and the character-level ones would need re-tokenising back to
words to keep the current UX. Same for swapping the diff parser (`parse-diff` /
`gitdiff-parser`): git round-trip is ~20ms, parsing is not the bottleneck, and
this repo's parser carries Snipcode-specific label/rename/no-newline semantics.

## Paths with no remaining headroom

`RecentCommits.svelte` / `workbench-store.svelte.ts` /
`recent-commits-view.ts` (a fast-pass snapshot runs parallel with three ~10ms
reads and never waits for the deep walk); activation
(`extension.ts` → `graph/src/extension.ts`, where the cost is exactly the
discovery and status above, and three same-tick `discoverRepos` calls already
share one walk); and the five git spawns a file open costs (~20ms).
