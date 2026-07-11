# AGENTS.md — ClipCodeVSCode (Snipcode)

Single source of truth for AI agents (Codex, Claude Code, Gemini) in this repo.
`CLAUDE.md` imports this file — edit here only.

**Snipcode** (`clipcode-vscode`) — VS Code extension that copies and restores
files using the **IntelliJ ClipCode clipboard format**, plus a bundled commit
graph view. It is the VS Code port of the sibling IntelliJ plugin ClipCode.

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

Format authority on this side: `src/clipboardFormat.ts` — `buildPayloadInternal`
+ `escapeContent` (build), `parseClipboard` + `unescapeContent` + `joinContent`
(parse). The IntelliJ mirror is `ClipCode/src/main/kotlin/com/github/audichuang/clipcode/ClipboardPayloadFormatter.kt`
(build) + `ChangeTypeLabel.kt` / `ClipboardRestoreParser.kt` (labels + parse).
**Change labels, bracket syntax, header rules, or the escape marker on one side →
update the other, or cross-tool restore silently breaks.**

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

## Two parts of this repo

- **root `src/`** — the Snipcode extension host, the part you usually edit:
  copy/restore, git-aware copy, path filtering, the git history view.
- **`graph/`** — a *vendored* copy of git-graph-plus (its own Svelte webview and
  build). It has its own context — see `graph/AGENTS.md`. The host bundles its
  webview assets via `scripts/copy-graph-assets.mjs`; its **extension-host** code
  (`graph/src/*.ts`) ships because root `src/extension.ts` does
  `require('../graph/src/extension')`, so `build:host` (esbuild) pulls it into
  `dist/extension.js`. To confirm a graph change shipped, grep `dist/extension.js`
  (host) or `dist/graph-webview/main.js` (webview). Don't install the standalone
  git-graph-plus extension alongside Snipcode (command/view id clash).

## Build / test

    npm run build        # graph deps + graph webview + host bundle
    npm test             # tsc compile + node --test (host unit tests)
    npm run test:e2e     # headless VS Code integration tests
    npx vsce package     # → clipcode-vscode-<version>.vsix

Note: `npm test` runs **host** tests only — the graph webview has a separate
vitest suite (`cd graph && npx vitest run`). Run it if you touch `graph/`.

Gotcha: piping a build/test command (`| tail`/`| grep`) gives the pipe's exit code, not
npm/vitest/vsce's — judge pass/fail by the `pass N, fail 0` / `Tests …` / `BUILD SUCCESSFUL`
TEXT in the output, not `$?`.

**A green test is not a spec.** Suites here have repeatedly locked the CURRENT
(buggy) behavior into their expectations — e.g. PR open/copy asserting symbolic
refs, pull asserting an unconditional stash pop — so a correct fix turns them
red. When a fix flips a test, first ask whether the assertion encoded intent or
just the status quo; invert status-quo tests in the SAME change, don't weaken
the fix to keep them green. Also know what green means: `test:e2e` covers
activation, a webview boot handshake, and one copy→clipboard→restore round-trip
— it does NOT exercise git mutations, multi-repo, or destructive restore.
Coverage gaps + the agreed test matrix: `docs/research/2026-07-11-e2e-test-strategy.md`
(risk audit behind it: `docs/research/2026-07-10-vscode-git-operations-audit.md`).

## Release

Pushing a `v<version>` tag runs `.github/workflows/publish.yml` (test → build →
e2e → `vsce publish`). **A release is not done when CI goes green** — the new
version becomes live on the Marketplace minutes later. Use the
`vscode-extension-release` skill: it drives the full bump → tag → watch-CI →
poll-marketplace-until-live flow. Open VSX is not set up yet (namespace
unclaimed) — VS Code Marketplace only for now.

## Where to start in the code

`src/clipboardFormat.ts` (the shared format), `src/copy.ts` + `src/restore.ts`
(copy/restore), `src/gitCopy.ts` + `src/gitContent.ts` (git-aware copy),
`src/graphCopy.ts` (Copy Full Source from the graph view), and
`src/pathResolver.ts` + `src/filterMatcher.ts` + `src/settings.ts` (mirror
ClipCode's resolver / filter / settings). For full structure read `src/` — don't
trust a hand-written tree.

PR compare tab (pick base→head, inline diff, copy): `graph/webview-ui/src/components/pr/PrView.svelte`
(webview UI) + `graph/src/git/git-service.ts` `commitsBetween` (host: base...HEAD three-dot
diff/commits/merge-base). It's a Snipcode feature added INSIDE the vendored graph webview —
fence every `graph/` edit with `/* SNIPCODE-HOOK start/end */` for upstream re-sync.

## Permissions

Ask before publishing/tagging a release (it ships to real users) or editing
`.github/workflows/`. The `VSCE_PAT` secret lives in GitHub Actions secrets —
never put it in the repo.
