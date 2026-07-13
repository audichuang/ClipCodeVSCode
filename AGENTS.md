# AGENTS.md — ClipCodeVSCode (Snipcode)

Single source of truth for AI agents (Codex, Claude Code, Gemini) in this repo.
`CLAUDE.md` imports this file — edit here only.

**Snipcode** (`clipcode-vscode`) — VS Code extension that copies and restores
files using the **IntelliJ ClipCode clipboard format**, plus a bundled Git
graph and a **Snipcode Git** commit workbench. It is the VS Code port of the
sibling IntelliJ plugin ClipCode.

## Sibling: ClipCode (shared clipboard format — keep compatible)

ClipCode (IntelliJ plugin, Kotlin) is the original. **The clipboard text format
is a cross-tool contract** — files copied here restore in ClipCode and vice versa.
Both sides must agree on:

- a per-file header built from a `headerFormat` with a `$FILE_PATH` placeholder
- change labels `[NEW] [MODIFIED] [DELETED] [MOVED]` prefixed onto the path
- pre/post text wrapping + the blank-line-between-files option
- the `//clipcode-esc: ` escape prefix (`ESCAPE_MARKER`): a content line that
  itself parses as a header is escaped on copy and unescaped on paste, so a file
  containing a literal `// file: …` line round-trips instead of splitting into a
  phantom file. The marker MUST be byte-identical on both sides.
- the optional leading `// clipcode-root: <name>` metadata line (source-root
  basename): emitted only for a **single-root copy context** (one workspace /
  source root, or a single-repo graph copy) — not merely “one VS Code window”.
  Paste & Restore uses it to align folder levels (`restoreBase.ts` / IntelliJ
  `RestoreBase.kt`); parsers drop it before the first header so it never becomes
  a file. Also byte-identical on both sides.

Format authority on this side: `src/clipboardFormat.ts` — `buildPayloadInternal`
+ `escapeContent` (build), `parseClipboard` + `unescapeContent` + `joinContent`
(parse). The IntelliJ mirror is `ClipCode/src/main/kotlin/com/github/audichuang/clipcode/ClipboardPayloadFormatter.kt`
(build) + `ChangeTypeLabel.kt` / `ClipboardRestoreParser.kt` (labels + parse).
**Change labels, bracket syntax, header rules, the escape marker, or the root
metadata line on one side → update the other, or cross-tool restore silently breaks.**

Strict-alignment invariants (must match the Kotlin mirror byte-for-byte):
- Header + label regexes use the explicit `ASCII_WS` class, NOT JS Unicode `\s`
  (which would treat a full-width-space-indented line as a header when Kotlin does
  not, splitting a phantom file cross-tool).
- `formatHeader` substitutes `$FILE_PATH` via `split('$FILE_PATH').join(...)`, never
  `replaceAll(str, str)` — a string replacement expands `$&`/`$$` and corrupts paths
  containing them (even in this tool's own round-trip).
- Known accepted residual: `.trim()`/`\s`-blank tests differ from Kotlin on
  U+001C–U+001F and U+FEFF; only matters when a whole structural line is such
  control/BOM chars, which real payloads never contain.

**Cross-tool contract is pinned by golden fixtures.** `test/fixtures/clipboard-contract.json`
is committed byte-identically here and in `ClipCode/src/test/resources/`; it is
generated from THIS implementation (the format authority) by
`scripts/gen-contract-fixtures.cjs`. `test/contract.test.ts` (here) and
`ContractFixturesTest` (IntelliJ) both assert build + parse match those frozen bytes,
with a SHA guard so the copies can't drift. To change the format: edit both impls,
`npm run compile`, rerun the generator, copy the JSON to both repos, and update
`EXPECTED_FIXTURES_SHA` on both sides. Round-trip is also guarded by
`test/clipboardFormat.test.ts` and the e2e `test-e2e/suite/roundtrip.test.ts`.

## Roles in this repo

| Area | Role |
|---|---|
| root `src/` | Extension host: copy/restore, git-aware copy, path filters, History view, **inline blame** (`src/blame/`) |
| `graph/` | Vendored git-graph-plus **plus Snipcode Git**: commit graph webview, multi-repo **Changes** tree + commit box, full-width **Diff** tab (staged/unstaged, hunk/line stage). Own context: `graph/AGENTS.md` |

**Bundling (non-obvious):** webview assets ship via `scripts/copy-graph-assets.mjs`
into `dist/graph-webview/`. Extension-host code under `graph/src/` ships because
root `src/extension.ts` does `require('../graph/src/extension')`, so `build:host`
(esbuild) pulls it into `dist/extension.js`. To confirm a graph change shipped, grep `dist/extension.js` (host) and/or
`dist/graph-webview/{main,workbench,diff}.js` (three classic webview bundles —
see `graph/AGENTS.md`). **Do not** install the standalone git-graph-plus
extension alongside Snipcode (command/view id clash).

Snipcode-only edits inside `graph/` must be fenced with
`/* SNIPCODE-HOOK start/end */` so upstream re-syncs stay mergeable.

## Build / test

    npm run build        # graph deps + graph webview + host bundle
    npm test             # tsc compile + node --test (host unit tests)
    npm run test:e2e     # headless VS Code integration tests
    npx vsce package     # → clipcode-vscode-<version>.vsix

- `npm test` = **host** tests only. If you touch `graph/`, also run
  `cd graph && npx vitest run` (and prefer a single file when iterating).
- Visual changes under `graph/webview-ui/**` need the `verify-webview-ui` skill
  (headless screenshot) — green vitest does not prove layout.
- Piping a build/test command (`| tail`/`| grep`) gives the pipe's exit code, not
  npm/vitest/vsce's — judge pass/fail by the `pass N, fail 0` / `Tests …` text,
  not `$?`.

**A green test is not a spec.** Suites here have repeatedly locked the CURRENT
(buggy) behavior into their expectations — e.g. PR open/copy asserting symbolic
refs, pull asserting an unconditional stash pop — so a correct fix turns them
red. When a fix flips a test, first ask whether the assertion encoded intent or
just the status quo; invert status-quo tests in the SAME change, don't weaken
the fix to keep them green.

What green `test:e2e` means **today** (see `test-e2e/suite/`): activation,
graph webview **boot handshake**, copy→clipboard→restore round-trip, graph
copy-full-source at a commit (MODIFIED/DELETED/MOVED/NEW) + UNCOMMITTED
working-tree copy, blame-toggle smoke. It still does **not** exercise git
mutations (stage/commit/push), multi-repo staging, or overwrite-conflict
restore. The aspirational coverage matrix is
`docs/research/2026-07-11-e2e-test-strategy.md` §3 — **do not trust that doc's
§1 “current guarantees” inventory** (it predates the boot handshake shipped in
0.3.36). Risk audit behind it:
`docs/research/2026-07-10-vscode-git-operations-audit.md`.

## Release

Pushing a `v<version>` tag runs `.github/workflows/publish.yml` (test → build →
e2e → `vsce publish`). **A release is not done when CI goes green** — the new
version becomes live on the Marketplace minutes later. Use the
`vscode-extension-release` skill: bump → tag → watch-CI →
poll-marketplace-until-live. Open VSX is not set up yet (namespace unclaimed) —
VS Code Marketplace only for now.

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
