# AGENTS.md — ClipCodeVSCode (Snipcode)

Single source of truth for AI agents in this repo. `CLAUDE.md` imports this file
— edit here only.

**Snipcode** (`clipcode-vscode`) — VS Code extension that copies and restores
files using the **IntelliJ ClipCode clipboard format**, plus a bundled Git graph
and a **Snipcode Git** commit workbench. It is the VS Code port of the sibling
IntelliJ plugin ClipCode.

## Clipboard format — this side is the format authority

The format itself, its byte-for-byte invariants, and the fixture-regeneration flow
are **shared** with the IntelliJ sibling and live in the work-root `AGENTS.md`.
Read that before changing anything about the wire format — and note the fixtures
are generated from **this** implementation, so a format change starts here. From a
lone clone, the executable copy of the contract is
`test/fixtures/clipboard-contract.json` + `test/contract.test.ts` — build, parse, token
stats and (`pathCases`) path resolution of both writes and deletes.

Implementation: `src/clipboardFormat.ts` — `buildPayloadInternal` + `escapeContent`
(build), `parseClipboard` + `unescapeContent` + `joinContent` (parse). The Kotlin
mirror is `ClipCode/src/main/kotlin/com/github/audichuang/clipcode/ClipboardPayloadFormatter.kt`
(build) + `ChangeTypeLabel.kt` / `ClipboardRestoreParser.kt` (labels + parse).

TS-side pins for the shared invariants:

- Header and label regexes use the explicit `ASCII_WS` class, **not** JS Unicode
  `\s` (which would treat a full-width-space-indented line as a header when Kotlin
  does not, splitting a phantom file cross-tool).
- `formatHeader` substitutes via `split('$FILE_PATH').join(...)`, never
  `replaceAll(str, str)` — a string replacement expands `$&`/`$$` and corrupts
  paths containing them, even in this tool's own round-trip.
- The `// clipcode-root:` line is emitted only for a **single-root copy context**
  (one workspace / source root, or a single-repo graph copy) — not merely "one
  VS Code window". Every copy entry point owes it, the History view included.
- `GENERIC_FILE_HEADER` spells the token out as `[Ff][Ii][Ll][Ee]:` instead of using
  `/i`: Kotlin's `IGNORE_CASE` folds the Turkish dotless `ı` (U+0131) onto `i` and JS
  refuses to, so `// fıle: x.ts` was content here and a header in IntelliJ.
- Path-shape regexes never use `.` — `[\s\S]` for "any character". JS's `.` skips four
  line terminators and Java's five (U+0085 too), and a lone `\r` survives the `\r?\n`
  header split, so `.` made `D:/a\rb.txt` Windows-style here and not in IntelliJ.
  Kotlin mirrors: `ClipboardPathResolver` `WINDOWS_STYLE_PATH` / `WINDOWS_ABSOLUTE_PATH`,
  `CopyPathFormatter`, `PathRuleMatcher`.
- An absolute path matching no root is kept LITERALLY under the primary root on a write
  (`literalAbsoluteCandidate`: drive colon stripped, every directory kept), never on a
  delete — IntelliJ 1.2.14's rule, row 5 of the work-root `AGENTS.md`. A test asserting
  `/etc/passwd` resolves to `<root>/etc/passwd` is that rule, not a hole.
- The builder emits `POST_TEXT_MARKER` (`// clipcode-end`) before a non-empty post text
  and the parser stops there. Do NOT reintroduce a `postText` parameter on
  `parseClipboard` — see the work-root `AGENTS.md` for why reconstructing the footer from
  the receiver's setting silently deletes real content.
- No `String.trim()` in the parse path — `asciiTrim` only, `restore.ts isPlaceholderBody`
  included.
- Git-revision reads go through `repo.buffer` + the strict decoder FIRST (`gitContent.ts
  readRefContent`); `repo.show` returns an already-decoded string, so asking it first
  skips the UTF-8 guard and hands back U+FFFD mojibake. **`catFile.ts` is the other half**
  — it is the NORMAL path for Graph/PR/commit copies (`readRefContent` is only the
  spawn-failure fallback), so it must use `decodeUtf8OrSkip`, never
  `Buffer.toString('utf8')`.
- `collectGitPayloadFiles` does not count `UNREADABLE_FILE_MARKER` as a copied file and does
  not let it consume `fileCountLimit` — it is still pushed into the payload. Mirror of
  `GitClipboardPayloadBuilder`; see the work-root `AGENTS.md`.
- Filtering uses `PreparedFile.filterPath` / the clipboard path from
  `toClipboardPathFromRoots`, never a repo-relative header, and `matchesRule` refuses a
  relative PATH rule when that path is absolute — see the work-root `AGENTS.md`. The graph
  surface labels a MULTI-repo payload through the workspace roots for the same reason:
  prefixing every repo with its basename is a spelling restore cannot read back
  (`alpha/secret.txt` resolved to `alpha/alpha/secret.txt`).
- `listFilesRecursive` walks a directory symlink only when it IS the selected input, never
  during recursion. Right-clicking a linked folder used to copy nothing; following links
  everywhere is worse — a cross-linked tree (pnpm's `.pnpm`, Bazel) has a path count that
  grows like a sum of falling factorials, and with the default 30-file limit the copy
  becomes 30 aliases of the same few files while the real tree is dropped. IntelliJ's
  own walker has that hazard; do not import it.

Beyond the frozen fixtures, round-trip is guarded by `test/clipboardFormat.test.ts`
and the e2e `test-e2e/suite/roundtrip.test.ts`.

## Roles in this repo

| Area | Role |
|---|---|
| root `src/` | Extension host: copy/restore, git-aware copy, path filters, History view, **inline blame** (`src/blame/`) |
| `graph/` | Vendored git-graph-plus **plus Snipcode Git**: commit graph webview, multi-repo **Changes** tree + commit box, full-width **Diff** tab (staged/unstaged, hunk/line stage). Own context: `graph/AGENTS.md` |

**Bundling (non-obvious):** webview assets ship via `scripts/copy-graph-assets.mjs`
into `dist/graph-webview/`. Extension-host code under `graph/src/` ships because
root `src/extension.ts` does `require('../graph/src/extension')`, so `build:host`
(esbuild) pulls it into `dist/extension.js`. To confirm a graph change shipped, grep
`dist/extension.js` (host) and/or `dist/graph-webview/{main,workbench,diff}.js`
(three classic webview bundles — see `graph/AGENTS.md`). **Do not** install the
standalone git-graph-plus extension alongside Snipcode (command/view id clash).

Snipcode-only edits inside `graph/` must be fenced with
`/* SNIPCODE-HOOK start/end */` so upstream re-syncs stay mergeable.

## Build / test

    npm run build        # graph deps + graph webview + host bundle
    npm test             # tsc compile + node --test (host unit tests)
    npm run test:e2e     # headless VS Code integration tests
    npx vsce package     # → clipcode-vscode-<version>.vsix

- `npm test` = **host** tests only. If you touch `graph/`, also run
  `cd graph && npx vitest run` (and prefer a single file when iterating).
- Judge pass/fail by the `pass N, fail 0` / `Tests …` text.

**Before every commit, after the final edits, run `npm run test:precommit` from
this root and require exit code 0.** It rebuilds the current Webview and runs
host/graph tests, real-browser layout and performance gates, and worker parity.
A browser that can be neither found nor fetched, timeouts, failed
budgets, or omitted required checks block the commit; do not bypass checks or relax
budgets to obtain green. The gates no longer need a preinstalled Chrome: with none
present, `scripts/verify-diff-layout.mjs` fetches its pinned `HEADLESS_SHELL_BUILD`
into the gitignored `.cache/browsers/` — which `.vscodeignore` must keep out of the
VSIX, because `vsce` reads that file and never `.gitignore` (it shipped a 93 MB
package once). **`proxy-agent` and `yauzl` look unused and must stay:** nothing here
imports them, they are optional peers `@puppeteer/browsers` loads dynamically, and
without them the download ignores `HTTPS_PROXY` and needs a system `unzip` — both
failures happen only on machines unlike the one running the cleanup (see the comment
above `downloadHeadlessShell()` in `scripts/verify-diff-layout.mjs`). Diagnose
failures and report intentional suite skips separately. The check scope,
prerequisites, metrics and reports are defined in
`docs/testing/diff-webview-regressions.md`.

**A green test is not a spec.** Suites here have repeatedly locked the CURRENT
(buggy) behavior into their expectations — e.g. PR open/copy asserting symbolic
refs, pull asserting an unconditional stash pop — so a correct fix turns them
red. When a fix flips a test, first ask whether the assertion encoded intent or
just the status quo; invert status-quo tests in the SAME change, don't weaken
the fix to keep them green.

What `test:e2e` covers is whatever lives in `test-e2e/suite/`. What it still does
**not** exercise: git mutations (stage/commit/push), multi-repo staging, and
overwrite-conflict restore. The aspirational coverage matrix is
`docs/research/2026-07-11-e2e-test-strategy.md` §3 — **do not trust that doc's §1
"current guarantees" inventory**, it predates the boot handshake. Risk audit behind
it: `docs/research/2026-07-10-vscode-git-operations-audit.md`.

## Release

**Run `scripts/release.sh <version>`.** It preflights (on `main`, clean tree, in
sync with origin, `package.json` **and** `package-lock.json` at that version, tag
unused), tags, pushes, waits for `.github/workflows/publish.yml` (test → build →
e2e → `vsce publish`), then polls the Marketplace until it actually serves the new
version and the VSIX downloads. It prints one line — `OK v0.3.48 live: <url>` or
`FAIL: <reason>` — and exits 0 only when live.

**A release is not done when CI goes green** — the Marketplace verifies and indexes
the upload 5–8 minutes later (measured on real releases). That lag is the whole
reason the script exists: the poll was documented here in prose and got skipped
anyway, shipping a "released" claim for a version nobody could install yet. Don't
hand-roll the tag-and-hope sequence. `npm ci` does not check the version field, so a
stale lockfile ships silently — the script refuses rather than let that through.

Open VSX is not set up yet (namespace unclaimed) — VS Code Marketplace only for now.
(A `vscode-extension-release` skill covers the same ground, but it lives outside this
repo and is not guaranteed to load.)

## Where to start in the code

**Copy / restore (ClipCode parity):** `src/clipboardFormat.ts`, `src/copy.ts` +
`src/restore.ts`, `src/gitCopy.ts` + `src/gitContent.ts`, `src/graphCopy.ts`,
`src/pathResolver.ts` + `src/filterMatcher.ts` + `src/settings.ts`.

**Inline blame:** `src/blame/` (toggle command + per-editor decorations; host-side,
not in the graph webview).

**Snipcode Git workbench + Diff + graph:** see `graph/AGENTS.md`. Entry points:
`graph/src/tree/changes-workbench.ts` (TreeView staging),
`graph/src/tree/commit-box-view.ts` (commit message webview),
`graph/src/panels/DiffPanel.ts` (full-width Diff tab),
`graph/src/panels/MainPanel.ts` (commit graph).

**PR compare tab** (base→head, inline diff, copy): `graph/webview-ui/src/components/pr/PrView.svelte`
+ `graph/src/git/git-service.ts` `commitsBetween` (base...HEAD three-dot). Snipcode
feature *inside* the vendored graph — fence with `SNIPCODE-HOOK`.

For full structure, read the directories — don't trust a hand-written tree.

## Permissions

Ask before publishing/tagging a release (it ships to real users) or editing
`.github/workflows/`. The `VSCE_PAT` secret lives in GitHub Actions secrets —
never put it in the repo.
