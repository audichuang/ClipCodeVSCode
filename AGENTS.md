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
(parse). The IntelliJ mirror is `ClipCode/src/main/kotlin/com/github/audichuang/clipcode/ChangeTypeLabel.kt`
(+ `GitClipboardFormatter.kt` / `CopyFileContentAction.kt` / `ClipboardRestoreParser.kt`).
**Change labels, bracket syntax, header rules, or the escape marker on one side →
update the other, or cross-tool restore silently breaks.** Round-trip is guarded
by the unit tests in `test/clipboardFormat.test.ts` and the e2e test
`test-e2e/suite/roundtrip.test.ts`.

## Two parts of this repo

- **root `src/`** — the Snipcode extension host, the part you usually edit:
  copy/restore, git-aware copy, path filtering, the git history view.
- **`graph/`** — a *vendored* copy of git-graph-plus (its own Svelte webview and
  build). It has its own context — see `graph/CLAUDE.md`. The host bundles its
  built assets via `scripts/copy-graph-assets.mjs`. Don't install the standalone
  git-graph-plus extension alongside Snipcode (command/view id clash).

## Build / test

    npm run build        # graph deps + graph webview + host bundle
    npm test             # tsc compile + node --test (host unit tests)
    npm run test:e2e     # headless VS Code integration tests
    npx vsce package     # → clipcode-vscode-<version>.vsix

Note: `npm test` runs **host** tests only — the graph webview has a separate
vitest suite (`cd graph && npx vitest run`). Run it if you touch `graph/`.

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

## Permissions

Ask before publishing/tagging a release (it ships to real users) or editing
`.github/workflows/`. The `VSCE_PAT` secret lives in GitHub Actions secrets —
never put it in the repo.
