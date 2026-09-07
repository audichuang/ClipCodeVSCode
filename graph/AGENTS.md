# AGENTS.md — git-graph-plus (vendored inside Snipcode)

> **Vendored sub-project**, not a standalone install. Bundled into Snipcode
> (`clipcode-vscode`); host wiring and marketplace release live in `../AGENTS.md`.
> This file is the single source of truth for **this folder** — `CLAUDE.md` is
> just `@AGENTS.md`. (Upstream ships notes as `CLAUDE.md`; on re-sync, port doc
> changes **into this file**.)

## What this folder is

Upstream **Git Graph Plus**: commit graph, branch/tag/stash/worktree management,
and related git GUI — Node extension host + **Svelte 5** webview.

**Snipcode adds on top of that** (do **not** re-delegate these to built-in SCM;
do **not** reintroduce `CommitWorkbenchViewProvider` / native `SnipcodeScmManager`
without a design decision — those are dead paths that only remain in old plans):

| Feature | Live path |
|---|---|
| Multi-repo **Changes** tree (real stage/unstage/commit) | **Owner:** `src/tree/changes-workbench.ts` (+ `build-change-tree.ts`, `changes-tree.ts`). Ops: `GitService.stagePaths` / `unstagePaths` / `commitIndex` / `stageHunks` / `unstageHunks` / `stageLines` / `unstageLines` |
| **Commit** message box (one shared message across repos) | `src/tree/commit-box-view.ts` (`CommitBoxViewProvider`) → `workbench.js` → `ChangesWorkbench.commit()` |
| **Recent Commits** sidebar overview + commit details | `src/tree/recent-commits-view.ts` → `workbench.js` → `RecentCommits.svelte`; follows HEAD history without replacing the active editor. A row click (or ↑/↓, Ctrl+↑/↓ for parent/child) selects it and opens the details panel below the list: full message, author + relative time, committer when it differs, clickable parents, changed files. A file row opens the native diff, its inline action opens the working file, the header opens all files in one multi-diff (`vscode.changes`). Right-click gives Copy SHA / Short SHA / Commit Info / Message and **Copy Full Source** (transfer to `MainPanel.copyFullSourceAtCommit` + `MainPanel.copyRuntime`, payload built host-side). Reuses `GitService.showCommitFiles` / `resolveCommitFileBases` + `utils/git-uri.ts` — the same comparison `MainPanel` opens for a graph row |
| Full-width **Diff** tab (unified staged+unstaged, hunk/line stage, word-diff) | `src/panels/DiffPanel.ts` → `diff.js` |
| Fetch / Pull / Push all repos + ↓↑ badges | `ChangesWorkbench.fetchAll` / `pullAll` / `pushAll` + root `package.json` `view/title` menus when `view == snipcode.changes`; badges from `GitService.aheadBehind` on tree repo nodes — **not** the graph webview `Toolbar.svelte` |
| PR compare tab | `webview-ui/.../pr/PrView.svelte` + `GitService.commitsBetween` |
| **Inline blame** | Host `../src/blame/` (not this folder) |

Fence every Snipcode-only edit with `/* SNIPCODE-HOOK start/end */` for upstream re-sync.

## Build & test (from this folder)

Standalone `npm run build` / `npm run package` survive for upstream-style dev,
but Snipcode packaging is **always from the repo root**. Which suites to run
when: `../AGENTS.md`; the two vitest projects: "Key conventions" below.

## Roles (not a file tree)

| Area | Role |
|---|---|
| `src/git/git-service.ts` | Central git CLI hub; almost all ops go through it. **Merge parents:** `showCommitFiles` returns the UNION of the diffs against every parent, so pairing it with `resolveDiffBaseRef` (the FIRST parent) opens an empty diff for every file that arrived from parent 2..N — and the winning parent may not know a rename, making `oldPath` read a missing blob. Anything opening a native diff editor must use **`resolveCommitFileBases`** (ref *and* left path per file); the private `commitFileDiff` walks parents the same way for the in-webview diff, and `__tests__/integration/merge-file-base.integration.test.ts` pins the two to the same parent |
| `src/git/patch-builder.ts` | Pure patch builders for reverse-changes and forward stage/unstage hunks/lines. **Byte-safe:** it takes a raw `Buffer` and round-trips through `latin1`, never a UTF-8-decoded string — quoted-path/UTF-8/mixed-EOF fidelity. The Buffer (and the stale-diff fingerprint) comes from the **caller**: `git-service.ts` execs those diffs with `{encoding:'buffer'}`. Keep both ends buffer-typed or fidelity is lost before the builder ever runs |
| `src/utils/message-bus.ts` | Graph webview ↔ host message types + **live** `MESSAGE_EFFECTS` gate |
| `src/panels/MainPanel.ts` | Commit-graph WebviewPanel; message router + mutation transactions |
| `src/panels/DiffPanel.ts` | Snipcode Diff tab (classic `diff.js` bundle) |
| `src/tree/*` | **Live** Snipcode Git: Changes TreeView + `CommitBoxViewProvider` |
| `src/workbench/*` | **Mostly orphaned B-2a leftovers** (`getWorkbenchStatus` / `commitAcrossRepos` / `WORKBENCH_MESSAGE_EFFECTS`) — only used by their own tests. Live multi-repo commit is `ChangesWorkbench.commit()`. Do not wire new features through these helpers unless resurrecting that protocol. |
| `webview-ui/` | Svelte 5 UI (three entries — see the bundle table below) |
| `l10n/` + `webview-ui/src/lib/i18n/` | **Two separate** string systems, and only one is guarded: host `vscode.l10n.t` bundles (`l10n/bundle.l10n*.json`) vs webview dictionaries. `i18n/__tests__/parity.test.ts` fails if a webview key is missing from any dictionary; **nothing checks the host bundles**, so a key added to one of those and forgotten in another silently ships the raw key to that locale (zh-cn/zh-tw currently carry 26 keys neither `bundle.l10n.json` nor `ko` has). A key added to one system is invisible to the other |

Full structure: read the tree or search the code — do not maintain a hand-written inventory here.

## Three webview bundles (hard constraint)

Each bundle **must be self-contained** (no shared chunk, no top-level `import`).
Hosts load them as **classic** `<script nonce src>` (CSP `script-src 'nonce-…'`,
**not** `type="module"`). A top-level `import` → parse fail → blank panel →
handshake timeout (`sent no message within 15000ms`).

| Bundle | Vite config | Loaded by |
|---|---|---|
| `main.js` | `webview-ui/vite.config.ts` | `MainPanel` (graph) |
| `workbench.js` | `vite.workbench.config.ts` (`inlineDynamicImports`) | `CommitBoxViewProvider` / `RecentCommitsViewProvider` |
| `diff.js` | `vite.diff.config.ts` | `DiffPanel` |

`webview-ui`'s `build` runs these **three single-entry** builds back-to-back.
**Do not** merge into one multi-entry Vite build (shared Svelte runtime chunk →
all three boot blank). Root `scripts/copy-graph-assets.mjs` asserts all three
`.js`/`.css` pairs exist.

`main.js` and `diff.js` carry Shiki; `workbench.js` does not — and their CSP
differs because of it. Those two panels add `'wasm-unsafe-eval'` to `script-src`
so Shiki's oniguruma WASM engine can compile; without it compilation is refused
outright (`WebAssembly.CompileError`) and every diff renders as plain text. Give
a Shiki-using feature to `workbench.js` and it fails **silently** until
`commit-box-view.ts` / `recent-commits-view.ts` get the directive too.

The no-top-level-`import` rule above is about **static** imports. A classic
`<script nonce>` **can** `import()` at runtime — the nonce is inherited, checked
against the built `assets/` chunks — which is how `main.js` lazy-loads grammars.
Don't re-litigate this to justify inlining.

**Diff-open latency is dominated by Shiki tokenising**, not git and not bundle
size: ~250ms–1.3s of tokenising against ~20ms for the five git invocations one
file open costs and ~17ms to parse a 3MB bundle (519-file repo, Linux). Chunking
and yielding is not the same as progressive rendering — publish each chunk, or
input stays responsive while the diff stays plain for the whole pass. Measure
before optimising anything else here.

The grammar warm-up hangs off the **`diffLoading` message** (`diff.ts` has its own
listener for it), so a path that pushes a diff without posting that message first
tokenises its first screen with a cold grammar — a coupling neither file shows on
its own. Its snippet is sized to the 20–50ms window git actually takes: a richer
one tokenises the first real screen ~5× faster but costs more main thread than it
saves, so hint→first-screen gets **worse**. Numbers for that and for everything
else already measured and rejected here (worker, row virtualisation, grammar
chunk-splitting, `STATUS_CONCURRENCY`, a status TTL cache, and every alternative
tokeniser from tree-sitter to prismjs): `../docs/research/2026-09-07-perf-audit.md`.

The tail's remaining 2.3× is **not** a package choice — it is threading shiki's
`grammarState` from one line to the next instead of restarting every line from
`INITIAL`. Two things block it, and both are design work rather than a patch: a
unified diff is **two interleaved streams** (state flows along context+delete and
context+add separately, reset at every hunk boundary — one stream lets a deleted
`/*` comment out an added line), and `highlightKey` stops being
content-addressed, so the D7 reuse cache that keeps a stage/unstage from
re-colouring every other line needs a new key.

`workbench.ts` chooses the commit box or recent graph from `body.dataset.view`.
Acquire the VS Code API lazily and install only the chosen view's listeners:
static imports run for both views, and a second `acquireVsCodeApi()` breaks boot.
Selecting a commit in the recent graph stays in the sidebar — only the explicit
Open Full Graph action turns the editor into the graph panel. Opening a *file*
from its details panel does open a diff tab, the way a file row does in every
VS Code sidebar; that is not the same thing as the view yanking you to the graph.

The details panel is a flex **sibling** of `.commit-list`, never a row inside it:
the graph SVG is absolutely positioned at `y = row * 22`, so anything injected
between rows throws every dot off its row. Inside it, the message block and the
file list are **separate scrollers** — one scroller let a long message push the
files (the reason the panel exists) out of view.

**The sidebar's `recentCommits*` messages are outside both mutation gates.** They
are ad-hoc `msg?.type ===` checks in `resolveWebviewView`, not members of
`WebviewMessage`, so neither `MESSAGE_EFFECTS` (the compile-time exhaustive one)
nor MainPanel's repo-switch transaction covers them. Everything wired there so
far is read-only or a transfer to an already-gated host handler; a checkout /
cherry-pick / revert / reset added here would race MainPanel's mutations
unchecked. Route those through the full graph instead.

Every commit-scoped sidebar message carries the `repoPath` its row came from and
the host drops it unless that is still the active repo: `extension.ts` switches
the active repo synchronously while this view only repaints after its git
queries finish, so a click can arrive for the repo the user was *looking* at.
Repo comparison uses `utils/path.ts` `samePath` (case-insensitive) — a local
`path.resolve` comparison normalizes separators but not the drive-letter case,
which silently dropped every request on Windows (#30).

## Matching native VS Code (webview layout)

Read native rather than guess: the installed
`.vscode-test/vscode-linux-x64-*/resources/app/out/vs/workbench/workbench.desktop.main.{js,css}`
carries the real geometry constants, `--vscode-*` theme tokens and algorithms of
VS Code's own views. The sidebar commit list's 22px rows, 11px lanes, r5 dots and
ref-pill sizing were measured out of it; guessing produced a 64px branch-name cap
nobody could read.

Column widths in `CommitGraph.svelte` do **not** respond to viewport pressure the
way the CSS suggests: `.col-message` is the only flexible column, so it absorbs
every pixel of shrink and the fixed right-hand columns keep their basis at any
width. Making one of them `flex`-shrinkable is inert — to give the subject room
you have to reduce a column's basis or shorten its content.

## Key conventions (踩雷)

- **`git/` modules stay free of `vscode` imports** — sole exception
  `git/vscode-git-bridge.ts` — so GitService/parsers stay unit-testable
  against real git. Other VS Code-aware bits live in `extension.ts` /
  `panels/`.
- **`SequenceGuard`** (`utils/sequence-guard.ts`): `issue()` before async work;
  apply results only if `isCurrent()` — stops late clicks overwriting newer UI.
- **Two lock layers (do not confuse them):**
  1. **`GitService.withMutationLock`** — per-command **and** per-`GitService`
     instance. `exec()` routes worktree/index mutations through it;
     network-only `fetch`/`push` stay unlocked (`pull` is locked — it can
     merge/rebase). Raw `spawn` that mutates (e.g. interactive rebase) must
     take the lock and `clearReadCache()` itself.
  2. **`runExclusive(repoPath)`** (`services/mutation-coordinator.ts`) —
     module-level, path-keyed. Used by **Changes/Diff** staging so two
     panels cannot race the same repo via different `GitService` instances.
     **MainPanel graph mutations do not call `runExclusive`** — they rely on
     instance lock + the MESSAGE_EFFECTS transaction below.
- **Repo-switch transaction:** `MainPanel.handleMessage` runs mutating graph
  messages as one transaction — a repo switch waits until the transaction
  (including terminal refresh/error handling) finishes, or later steps hit the
  wrong `gitService`. Classification is **`MESSAGE_EFFECTS`** in
  `message-bus.ts`, exhaustive over `WebviewMessage['type']` — **a new type
  without a class is a compile error**. That is the **live** gate.
  `WORKBENCH_MESSAGE_EFFECTS` in `src/workbench/workbench-messages.ts` is the
  same technique for a **legacy** workbench protocol; the live commit box does
  **not** consult it (it only handles `workbenchCommit` → `ChangesWorkbench.commit`).
- **Svelte 5 `$state` is a proxy** — never `postMessage` it raw (`DataCloneError`,
  often silent). Use `$state.snapshot(...)` or a plain copy.
- **Repo switch posts only `repoList`** (updates `active`), **not** `repoChanged`
  (file-watcher-only). Views that re-fetch on repo change should watch
  `uiStore.activeRepo`, not listen for `repoChanged`.
- **Mutating-op refresh order:** handlers post `operationComplete` **before**
  `await refreshAll()`; the graph repaints on `fullRefresh` / `logData`. UI that
  means “op done **and** graph updated” must key off those (plus
  `error`/`operationPaused`/`conflictData`), never bare `operationComplete`.
- **Request→response can fail or vanish.** On handler error the host posts
  `{type:'error', payload:{message, source:<request type>}}`; some reads drop
  the reply if the active repo switched mid-request. Waiters must handle
  matching `error` (`payload.source`) **and** a timeout, or spinners hang
  forever (squash-modal family). Correlate reused reply types with a key
  (`base`, `requestId`; the Diff stage/unstage family threads an
  `operationId` — `diff-${pageId}-${n}`, unique across pages, inherited when
  the same file is re-pushed — and drops non-matching `diffData`/replies).
- Settings namespace: `gitGraphPlus.*` via `utils/config.ts`. Locales differ
  on git terms: `zh` translates them (拉取/推送/变基), `ko` is mixed
  (당겨오기 alongside English "Push"), `en` is source — match the existing
  style of the locale file you touch, don't impose a blanket rule.
- **Vitest** (`vitest.config.mts`): `backend` (real git CLI; integration under
  `src/git/__tests__/integration/`, 30s timeout) + `webview` (happy-dom).
  Deterministic race tests use `git-shim.ts` via `setGitBinaryPath()` — restore
  in `afterEach`; POSIX-only; don't run shim suites concurrent with other
  real-git suites.

## Permissions

Release / marketplace / workflow edits: follow **`../AGENTS.md`**.

A visual change under `webview-ui/**` is not done until it has been **rendered
and looked at**: the webview vitest project runs on happy-dom, which computes no
layout, so `getBoundingClientRect` is all zeros and a positioning bug passes
every test. The committed harness and the method are
`docs/research/2026-09-06-ui-audit/render.md` + the `harness/` folder beside it.
Assert geometry with numbers, not by eyeballing the screenshot. (A
`verify-webview-ui` skill wraps this flow but lives outside this repo — the
harness is the part a clone actually gets.)
