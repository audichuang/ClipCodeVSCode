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
235ms DOM-only, i.e. ~80% tokenising. Per-line `codeToTokens` costs ~30% more
than batching a hunk (490ms vs 340ms for 3000 lines, Node) — a real but
non-blocking saving, since the tail streams in behind the first screen.

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
- **Batching `codeToTokens` per hunk** — the 30% tail saving above is real and
  would also fix multi-line constructs (block comments, template literals) that
  per-line tokenising gets wrong, but it makes the content-addressed
  `highlightKey` cache context-dependent. Worth doing on its own, not as part of
  a first-paint change.

## Paths with no remaining headroom

`RecentCommits.svelte` / `workbench-store.svelte.ts` /
`recent-commits-view.ts` (a fast-pass snapshot runs parallel with three ~10ms
reads and never waits for the deep walk); activation
(`extension.ts` → `graph/src/extension.ts`, where the cost is exactly the
discovery and status above, and three same-tick `discoverRepos` calls already
share one walk); and the five git spawns a file open costs (~20ms).
